const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let state = {
  accessToken: null,
  tokenExpiry: null,
  profileId: null,
  campaigns: [],
  portfolios: {},
  alerts: [],
  exhaustionLog: [],
  lastSync: null,
  syncing: false,
  error: null
};

async function getAccessToken() {
  if (state.accessToken && state.tokenExpiry && Date.now() < state.tokenExpiry - 60000) {
    return state.accessToken;
  }
  console.log('Refreshing access token...');
  const res = await axios.post('https://api.amazon.co.uk/auth/o2/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.AMAZON_REFRESH_TOKEN.trim(),
      client_id: process.env.AMAZON_CLIENT_ID.trim(),
      client_secret: process.env.AMAZON_CLIENT_SECRET.trim()
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  state.accessToken = res.data.access_token;
  state.tokenExpiry = Date.now() + (res.data.expires_in * 1000);
  console.log('Token refreshed OK');
  return state.accessToken;
}

async function getProfileId() {
  if (state.profileId) return state.profileId;
  const token = await getAccessToken();
  const res = await axios.get('https://advertising-api-eu.amazon.com/v2/profiles', {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Amazon-Advertising-API-ClientId': process.env.AMAZON_CLIENT_ID.trim()
    }
  });
  const uk = res.data.find(function(p) { return p.countryCode === 'GB' || p.countryCode === 'UK'; }) || res.data[0];
  state.profileId = uk.profileId;
  console.log('Profile ID: ' + state.profileId);
  return state.profileId;
}

function getHeaders(profileId, token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Amazon-Advertising-API-ClientId': process.env.AMAZON_CLIENT_ID.trim(),
    'Amazon-Advertising-API-Scope': String(profileId)
  };
}

// ── Fetch portfolios ──────────────────────────────────────────────────────
async function fetchPortfolios() {
  const token = await getAccessToken();
  const profileId = await getProfileId();
  try {
    const res = await axios.get('https://advertising-api-eu.amazon.com/v2/portfolios', {
      headers: getHeaders(profileId, token)
    });
    const map = {};
    res.data.forEach(function(p) { map[p.portfolioId] = p.name; });
    state.portfolios = map;
    console.log('Portfolios fetched: ' + Object.keys(map).length);
  } catch(e) {
    console.log('Portfolios from campaign data only');
  }
}

// ── Fetch campaigns ───────────────────────────────────────────────────────
async function fetchCampaigns() {
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const headers = Object.assign({}, getHeaders(profileId, token), {
    'Content-Type': 'application/vnd.spCampaign.v3+json',
    'Accept': 'application/vnd.spCampaign.v3+json'
  });
  const res = await axios.post(
    'https://advertising-api-eu.amazon.com/sp/campaigns/list',
    { stateFilter: { include: ['ENABLED'] } },
    { headers: headers }
  );
  const campaigns = res.data.campaigns || res.data || [];
  console.log('Campaigns fetched: ' + campaigns.length);
  return campaigns;
}

// ── Fetch spend/revenue via v2 report API ────────────────────────────────
let statsCache = { data: null, lastFetched: 0 };

async function fetchCampaignStats() {
  const now = Date.now();
  if (statsCache.data && (now - statsCache.lastFetched) < 60 * 60 * 1000) {
    console.log('Using cached stats (' + Math.round((now - statsCache.lastFetched)/60000) + ' min old)');
    return statsCache.data;
  }
  console.log('Requesting v2 stats report...');

  const token = await getAccessToken();
  const profileId = await getProfileId();
  const headers = getHeaders(profileId, token);
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');

  try {
    const reportRes = await axios.post(
      'https://advertising-api-eu.amazon.com/v2/sp/campaigns/report',
      {
        reportDate: today,
        metrics: 'campaignId,campaignName,cost,attributedSales14d,clicks,impressions'
      },
      { headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) }
    );

    const reportId = reportRes.data.reportId;
    console.log('V2 report requested: ' + reportId);

    let reportData = null;
    for (let i = 0; i < 12; i++) {
      await new Promise(function(r) { setTimeout(r, 5000); });
      const statusRes = await axios.get(
        'https://advertising-api-eu.amazon.com/v2/reports/' + reportId,
        { headers: headers }
      );
      console.log('Report status: ' + statusRes.data.status);
      if (statusRes.data.status === 'SUCCESS') {
        const downloadRes = await axios.get(statusRes.data.location, {
          responseType: 'arraybuffer',
          headers: headers
        });
        const zlib = require('zlib');
        const decompressed = zlib.gunzipSync(Buffer.from(downloadRes.data));
        reportData = JSON.parse(decompressed.toString());
        console.log('V2 report downloaded: ' + reportData.length + ' records');
        statsCache = { data: reportData, lastFetched: now };
        break;
      }
      if (statusRes.data.status === 'FAILURE') {
        console.log('V2 report failed: ' + JSON.stringify(statusRes.data));
        break;
      }
    }
    return reportData;
  } catch(e) {
    console.error('Stats fetch error: ' + e.message + (e.response ? ' ' + JSON.stringify(e.response.data) : ''));
    return statsCache.data || null;
  }
}

// ── Update campaign budget ────────────────────────────────────────────────
async function updateBudget(campaignId, newBudget) {
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const res = await axios.put(
    'https://advertising-api-eu.amazon.com/v2/sp/campaigns',
    [{ campaignId: campaignId, dailyBudget: newBudget }],
    {
      headers: Object.assign({}, getHeaders(profileId, token), { 'Content-Type': 'application/json' })
    }
  );
  return res.data;
}

// ── Google Chat ───────────────────────────────────────────────────────────
async function sendGoogleChat(message) {
  if (!process.env.GOOGLE_CHAT_WEBHOOK) return;
  await new Promise(function(resolve) { setTimeout(resolve, 1000); });
  try {
    await axios.post(process.env.GOOGLE_CHAT_WEBHOOK, { text: message });
    console.log('Google Chat sent');
  } catch(e) {
    console.error('Google Chat error: ' + e.message);
  }
}

// ── Analyse campaigns ─────────────────────────────────────────────────────
async function analyseCampaigns(campaigns) {
  const acosCritical = parseFloat(process.env.ACOS_CRITICAL_THRESHOLD || 35);
  const budgetLowPct = parseFloat(process.env.BUDGET_LOW_PERCENT || 20);
  const now = new Date();
  const timeStr = now.toTimeString().slice(0, 5);
  const dateStr = now.toDateString();
  let chatCount = 0;
  const maxChats = 5;

  for (let i = 0; i < campaigns.length; i++) {
    const c = campaigns[i];
    const budget = c.dailyBudget || 0;
    const spend = c.spend || 0;
    const sales = c.sales || 0;
    const acos = sales > 0 ? (spend / sales) * 100 : 0;
    const remaining = Math.max(0, budget - spend);
    const remainingPct = budget > 0 ? (remaining / budget) * 100 : 100;
    const outOfBudget = remaining <= 0.01 && budget > 0;
    const budgetLow = remainingPct <= budgetLowPct && !outOfBudget;
    const acosHigh = acos > acosCritical && spend > 5;
    const alertType = outOfBudget ? 'out_of_budget' : acosHigh ? 'acos_high' : budgetLow ? 'budget_low' : null;
    if (!alertType) continue;

    const alreadyAlerted = state.alerts.find(function(a) {
      return a.campaignId === c.campaignId && a.date === dateStr && a.type === alertType;
    });
    if (alreadyAlerted) continue;

    const name = c.name || 'Unknown';
    const portfolioName = c.portfolio || 'No portfolio';
    const agent = portfolioName.replace('@', '').split(' ')[0];

    state.alerts.push({ campaignId: c.campaignId, name: name, portfolio: portfolioName, agent: agent, type: alertType, time: timeStr, date: dateStr, budget: budget, acos: Math.round(acos * 10) / 10 });

    const dashUrl = process.env.DASHBOARD_URL || 'https://campaignpulse-setup-production.up.railway.app';

    if (outOfBudget && chatCount < maxChats) {
      const hoursLeft = (23 * 60 + 59 - now.getHours() * 60 - now.getMinutes()) / 60;
      const roas = spend > 0 ? sales / spend : 0;
      const hourly = spend / Math.max(now.getHours(), 1);
      const missed = Math.round(hourly * hoursLeft * roas);
      state.exhaustionLog.unshift({ date: now.toLocaleDateString('en-GB'), time: timeStr, campaign: name, portfolio: portfolioName, agent: agent, budget: '£' + budget.toFixed(2), acos: acos.toFixed(1) + '%', missed: '£' + missed, added: 'Pending', action: 'Pending' });
      const msg = '⚠ *OUT OF BUDGET*\n*Campaign:* ' + name + '\n*Portfolio:* ' + portfolioName + '\n*Agent:* ' + agent + '\n*Time:* ' + timeStr + '\n*Budget:* £' + budget.toFixed(2) + '\n*ACOS:* ' + acos.toFixed(1) + '%\n*Est. missed:* ~£' + missed + '\n\n' + dashUrl;
      await sendGoogleChat(msg);
      chatCount++;
    } else if (acosHigh && chatCount < maxChats) {
      const msg = '📈 *HIGH ACOS*\n*Campaign:* ' + name + '\n*Portfolio:* ' + portfolioName + '\n*Agent:* ' + agent + '\n*ACOS:* ' + acos.toFixed(1) + '%\n*Spend:* £' + spend.toFixed(2) + '\n\n' + dashUrl;
      await sendGoogleChat(msg);
      chatCount++;
    } else if (budgetLow && chatCount < maxChats) {
      const msg = '⚡ *BUDGET LOW*\n*Campaign:* ' + name + '\n*Portfolio:* ' + portfolioName + '\n*Agent:* ' + agent + '\n*Remaining:* £' + remaining.toFixed(2) + ' (' + remainingPct.toFixed(0) + '%)\n\n' + dashUrl;
      await sendGoogleChat(msg);
      chatCount++;
    }
  }
  if (chatCount > 0) console.log('Sent ' + chatCount + ' alerts');
}

// ── Main sync ─────────────────────────────────────────────────────────────
async function syncCampaigns() {
  if (state.syncing) return;
  state.syncing = true;
  console.log('Syncing at ' + new Date().toTimeString().slice(0, 8));
  try {
    await fetchPortfolios();
    const raw = await fetchCampaigns();

    // Fetch spend/revenue stats
    const stats = await fetchCampaignStats();
    const statsMap = {};
    if (stats && stats.length) {
      stats.forEach(function(s) {
        statsMap[s.campaignId] = { spend: s.cost || 0, sales: s.sales14d || 0, clicks: s.clicks || 0, impressions: s.impressions || 0 };
      });
      console.log('Stats loaded for ' + Object.keys(statsMap).length + ' campaigns');
    }

    const campaigns = raw.map(function(c) {
      const budget = parseFloat((c.budget && c.budget.budget) || c.dailyBudget || 0);
      const s = statsMap[c.campaignId] || {};
      const spend = parseFloat(s.spend || 0);
      const sales = parseFloat(s.sales || 0);
      const acos = sales > 0 ? Math.round((spend / sales) * 1000) / 10 : 0;
      const remaining = Math.max(0, budget - spend);
      const pct = budget > 0 ? Math.round((spend / budget) * 100) : 0;
      const portfolioName = c.portfolioId ? (state.portfolios[c.portfolioId] || '') : '';
      const agent = portfolioName ? portfolioName.replace('@', '').split(' ')[0] : '';
      return {
        campaignId: c.campaignId,
        name: c.name || '',
        state: (c.state || '').toLowerCase(),
        portfolio: portfolioName,
        agent: agent,
        dailyBudget: budget,
        spend: Math.round(spend * 100) / 100,
        sales: Math.round(sales * 100) / 100,
        acos: acos,
        clicks: s.clicks || 0,
        impressions: s.impressions || 0,
        budgetRemaining: Math.round(remaining * 100) / 100,
        budgetPct: pct
      };
    });

    state.campaigns = campaigns;
    await analyseCampaigns(campaigns);
    state.lastSync = new Date().toTimeString().slice(0, 8);
    state.error = null;
    console.log('Sync done. ' + campaigns.length + ' campaigns.');
  } catch(e) {
    state.error = e.message;
    console.error('Sync error:', e.message);
  } finally {
    state.syncing = false;
  }
}

// ── API Routes ────────────────────────────────────────────────────────────
app.get('/api/dashboard', function(req, res) {
  const campaigns = state.campaigns;
  const totalRevenue = campaigns.reduce(function(s, c) { return s + (c.sales || 0); }, 0);
  const totalSpend = campaigns.reduce(function(s, c) { return s + (c.spend || 0); }, 0);
  const blendedAcos = totalRevenue > 0 ? Math.round((totalSpend / totalRevenue) * 1000) / 10 : 0;
  const active = campaigns.filter(function(c) { return c.state === 'enabled'; }).length;
  const needsAction = campaigns.filter(function(c) {
    return c.budgetRemaining <= 0.01 || c.acos > parseFloat(process.env.ACOS_CRITICAL_THRESHOLD || 35) || c.budgetPct >= 80;
  }).length;
  res.json({
    metrics: { totalRevenue: totalRevenue.toFixed(2), totalSpend: totalSpend.toFixed(2), blendedAcos: blendedAcos, activeCampaigns: active, needsAction: needsAction },
    campaigns: campaigns,
    alerts: state.alerts.slice(-20),
    exhaustionLog: state.exhaustionLog,
    lastSync: state.lastSync,
    error: state.error
  });
});

app.get('/api/health', function(req, res) {
  res.json({ status: 'ok', lastSync: state.lastSync, campaigns: state.campaigns.length, error: state.error });
});

app.post('/api/sync', function(req, res) {
  syncCampaigns();
  res.json({ success: true });
});

app.post('/api/campaigns/:id/budget', async function(req, res) {
  const id = req.params.id;
  const amount = parseFloat(req.body.amount || 0);
  const campaign = state.campaigns.find(function(c) { return String(c.campaignId) === String(id); });
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  try {
    const newBudget = campaign.dailyBudget + amount;
    await updateBudget(id, newBudget);
    const log = state.exhaustionLog.find(function(e) { return e.campaign === campaign.name && e.action === 'Pending'; });
    if (log) { log.added = '+£' + amount; log.action = 'Budget added'; }
    await sendGoogleChat('✅ *Budget approved*\n*Campaign:* ' + campaign.name + '\n*Portfolio:* ' + (campaign.portfolio || 'N/A') + '\n+£' + amount + ' added. New budget: £' + newBudget.toFixed(2));
    syncCampaigns();
    res.json({ success: true, newBudget: newBudget });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/alerts/:campaignId/dismiss', function(req, res) {
  const id = req.params.campaignId;
  state.alerts = state.alerts.filter(function(a) { return String(a.campaignId) !== String(id); });
  res.json({ success: true });
});

const interval = process.env.POLL_INTERVAL_MINUTES || 15;
cron.schedule('*/' + interval + ' * * * *', function() { syncCampaigns(); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', function() {
  console.log('App running on port ' + PORT);
  setTimeout(function() {
    syncCampaigns().catch(function(err) { console.error('Initial sync failed:', err.message); });
  }, 30000);
});




