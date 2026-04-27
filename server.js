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

// ── Async report system — request now, download next cycle ───────────────
let reportState = { pendingReportId: null, data: null, lastFetched: 0, requested: 0 };

async function fetchCampaignStats() {
  const now = Date.now();
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const headers = getHeaders(profileId, token);
  const today = new Date().toISOString().split('T')[0];

  // If we have a pending report, check if it's ready
  if (reportState.pendingReportId) {
    try {
      const statusRes = await axios.get(
        'https://advertising-api-eu.amazon.com/reporting/reports/' + reportState.pendingReportId,
        { headers: Object.assign({}, headers, { 'Accept': 'application/json' }) }
      );
      const status = statusRes.data.status;
      console.log('Pending report status: ' + status);
      if (status === 'COMPLETED') {
        const downloadRes = await axios.get(statusRes.data.url, { responseType: 'arraybuffer' });
        const zlib = require('zlib');
        const decompressed = zlib.gunzipSync(Buffer.from(downloadRes.data));
        const reportData = JSON.parse(decompressed.toString());
        console.log('Report downloaded: ' + reportData.length + ' records');
        reportState.data = reportData;
        reportState.lastFetched = now;
        reportState.pendingReportId = null;
      } else if (status === 'FAILED') {
        console.log('Report failed, will retry next cycle');
        reportState.pendingReportId = null;
      }
    } catch(e) {
      console.error('Report check error: ' + e.message);
      reportState.pendingReportId = null;
    }
  }

  // Request a new report if we dont have one pending and data is older than 1 hour
  if (!reportState.pendingReportId && (now - reportState.requested) > 60 * 60 * 1000) {
    try {
      const reportRes = await axios.post(
        'https://advertising-api-eu.amazon.com/reporting/reports',
        {
          name: 'CampaignPulse ' + today,
          startDate: today,
          endDate: today,
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS',
            groupBy: ['campaign'],
            columns: ['campaignId', 'campaignName', 'cost', 'sales14d', 'clicks', 'impressions', 'purchases14d'],
            reportTypeId: 'spCampaigns',
            timeUnit: 'SUMMARY',
            format: 'GZIP_JSON'
          }
        },
        { headers: Object.assign({}, headers, { 'Content-Type': 'application/json', 'Accept': 'application/json' }) }
      );
      reportState.pendingReportId = reportRes.data.reportId;
      reportState.requested = now;
      console.log('Report requested: ' + reportState.pendingReportId + ' (will check next sync)');
    } catch(e) {
      console.error('Report request error: ' + e.message);
    }
  }

  return reportState.data || null;
}

// ── Update campaign budget ────────────────────────────────────────────────
async function updateBudget(campaignId, newBudget) {
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const headers = Object.assign({}, getHeaders(profileId, token), {
    'Content-Type': 'application/vnd.spCampaign.v3+json',
    'Accept': 'application/vnd.spCampaign.v3+json'
  });
  try {
    // Try v3 first
    const res = await axios.put(
      'https://advertising-api-eu.amazon.com/sp/campaigns',
      { campaigns: [{ campaignId: String(campaignId), budget: { budget: newBudget, budgetType: 'DAILY' } }] },
      { headers: headers }
    );
    console.log('Budget updated v3: ' + JSON.stringify(res.data).substring(0, 200));
    return res.data;
  } catch(e) {
    console.error('Budget update error: ' + e.response?.status + ' ' + JSON.stringify(e.response?.data));
    throw e;
  }
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
        statsMap[s.campaignId] = {
          spend: parseFloat(s.cost || s.spend || s['Spend'] || 0),
          sales: parseFloat(s.sales14d || s['7 Day Total Sales'] || s.sales || 0),
          clicks: parseInt(s.clicks || s['Clicks'] || 0),
          impressions: parseInt(s.impressions || s['Impressions'] || 0)
        };
      });
      console.log('Stats loaded for ' + Object.keys(statsMap).length + ' campaigns');
    }

    const campaigns = raw.map(function(c) {
      const budget = parseFloat((c.budget && c.budget.budget) || c.dailyBudget || 0);
      const s = statsMap[c.campaignId] || {};
      const spend = s.spend !== undefined ? parseFloat(s.spend) : null;
      const sales = s.sales !== undefined ? parseFloat(s.sales) : null;
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
    // Check search term report in background
    checkSearchTermReport().catch(function(e){ console.error('KW check error: ' + e.message); });
    requestSearchTermReport().catch(function(e){ console.error('KW request error: ' + e.message); });
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

// AI analysis endpoint
app.post('/api/ai/analyse', async function(req, res) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ error: 'No API key', suggestions: null });
    const allCamps = state.campaigns;
    const lowAcos = allCamps.filter(function(c) { return c.acos > 0 && c.acos < 15 && c.dailyBudget > 0; });
    const highAcos = allCamps.filter(function(c) { return c.acos > 35 && c.spend > 5; });
    const outOfBudget = allCamps.filter(function(c) { return c.budgetRemaining <= 0.01 && c.dailyBudget > 0; });
    const prompt = 'You are an Amazon Advertising expert for FK Sports UK. Give 4 specific recommendations based on: Total campaigns: ' + allCamps.length + ', Out of budget: ' + outOfBudget.length + ' (' + outOfBudget.slice(0,3).map(function(c){return c.name;}).join(', ') + '), High ACOS >35%: ' + highAcos.length + ' (' + highAcos.slice(0,3).map(function(c){return c.name + ' ' + c.acos + '%';}).join(', ') + '), Scale opportunities ACOS<15%: ' + lowAcos.length + ' (' + lowAcos.slice(0,3).map(function(c){return c.name + ' ' + c.acos + '%';}).join(', ') + '. Return ONLY JSON array of 4 objects with fields: type, title, campaign, detail, impact, action. No other text.';
    const aiRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-opus-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    });
    const text = aiRes.data.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    res.json({ suggestions: JSON.parse(clean) });
  } catch(e) {
    console.error('AI error: ' + e.message);
    res.json({ error: e.message, suggestions: null });
  }
});


// ── Keyword Intelligence ─────────────────────────────────────────────────
let keywordState = {
  reportId: null,
  requested: 0,
  data: null,
  analysis: null,
  lastAnalysed: 0
};

async function requestSearchTermReport() {
  const now = Date.now();
  // Only request new report once per week
  if (keywordState.reportId || (now - keywordState.requested) < 7 * 24 * 60 * 60 * 1000) {
    return;
  }
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const headers = getHeaders(profileId, token);
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  try {
    const res = await axios.post(
      'https://advertising-api-eu.amazon.com/reporting/reports',
      {
        name: 'CampaignPulse Search Terms ' + today,
        startDate: weekAgo,
        endDate: today,
        configuration: {
          adProduct: 'SPONSORED_PRODUCTS',
          groupBy: ['searchTerm'],
          columns: ['campaignId', 'campaignName', 'adGroupId', 'adGroupName', 'keywordId', 'keyword', 'matchType', 'searchTerm', 'cost', 'clicks', 'impressions', 'purchases14d', 'sales14d'],
          reportTypeId: 'spSearchTerm',
          timeUnit: 'SUMMARY',
          format: 'GZIP_JSON'
        }
      },
      { headers: Object.assign({}, headers, { 'Content-Type': 'application/json', 'Accept': 'application/json' }) }
    );
    keywordState.reportId = res.data.reportId;
    keywordState.requested = now;
    console.log('Search term report requested: ' + keywordState.reportId);
  } catch(e) {
    console.error('Search term report error: ' + e.message);
  }
}

async function checkSearchTermReport() {
  if (!keywordState.reportId) return;
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const headers = getHeaders(profileId, token);
  try {
    const statusRes = await axios.get(
      'https://advertising-api-eu.amazon.com/reporting/reports/' + keywordState.reportId,
      { headers: Object.assign({}, headers, { 'Accept': 'application/json' }) }
    );
    const status = statusRes.data.status;
    console.log('Search term report status: ' + status);
    if (status === 'COMPLETED') {
      const downloadRes = await axios.get(statusRes.data.url, { responseType: 'arraybuffer' });
      const zlib = require('zlib');
      const decompressed = zlib.gunzipSync(Buffer.from(downloadRes.data));
      keywordState.data = JSON.parse(decompressed.toString());
      keywordState.reportId = null;
      console.log('Search term report downloaded: ' + keywordState.data.length + ' records');
      await analyseKeywords();
    } else if (status === 'FAILED') {
      console.log('Search term report failed');
      keywordState.reportId = null;
    }
  } catch(e) {
    console.error('Search term check error: ' + e.message);
    keywordState.reportId = null;
  }
}

async function analyseKeywords() {
  if (!keywordState.data || !keywordState.data.length) return;
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('No Anthropic API key — skipping AI keyword analysis');
    // Still do rule-based analysis
    keywordState.analysis = ruleBasedKeywordAnalysis(keywordState.data);
    return;
  }
  try {
    const data = keywordState.data;
    // Find wasters — spend > 0, zero purchases
    const wasters = data.filter(function(r) {
      return parseFloat(r.cost || 0) > 1 && parseInt(r.purchases14d || 0) === 0;
    }).sort(function(a,b) { return parseFloat(b.cost||0) - parseFloat(a.cost||0); }).slice(0, 20);
    // Find converters — high purchases, not yet as exact match keyword
    const converters = data.filter(function(r) {
      return parseInt(r.purchases14d || 0) > 0 && r.matchType !== 'EXACT';
    }).sort(function(a,b) { return parseInt(b.purchases14d||0) - parseInt(a.purchases14d||0); }).slice(0, 20);
    // High spend, low conversion rate
    const inefficient = data.filter(function(r) {
      const spend = parseFloat(r.cost||0);
      const purchases = parseInt(r.purchases14d||0);
      const sales = parseFloat(r.sales14d||0);
      return spend > 5 && purchases > 0 && spend > sales;
    }).sort(function(a,b) { return parseFloat(b.cost||0) - parseFloat(a.cost||0); }).slice(0, 20);

    const prompt = 'You are an Amazon Advertising expert for FK Sports UK (sports equipment seller). Analyse this search term data and provide specific actionable recommendations.\n\nTop wasting search terms (spend, zero conversions):\n' +
      wasters.slice(0,10).map(function(r){ return r.searchTerm + ' | spend: £' + parseFloat(r.cost||0).toFixed(2) + ' | campaign: ' + r.campaignName; }).join('\n') +
      '\n\nTop converting search terms (not yet exact match keywords):\n' +
      converters.slice(0,10).map(function(r){ return r.searchTerm + ' | purchases: ' + r.purchases14d + ' | sales: £' + parseFloat(r.sales14d||0).toFixed(2) + ' | campaign: ' + r.campaignName; }).join('\n') +
      '\n\nTotal search terms analysed: ' + data.length +
      '\n\nProvide analysis in this JSON format only:\n{"wasteReduction":{"totalWasted":"£X","topWasters":[{"searchTerm":"","campaign":"","spend":"£X","recommendation":"Add as negative keyword","reason":""}],"estimatedSaving":"£X/week"},"newKeywords":{"totalOpportunities":0,"topOpportunities":[{"searchTerm":"","campaign":"","purchases":0,"sales":"£X","recommendation":"Add as exact match keyword","estimatedImpact":""}]},"bidChanges":[{"keyword":"","campaign":"","currentIssue":"","recommendation":"","expectedOutcome":""}],"portfolioInsights":{"patterns":"","topPerforming":"","needsAttention":""},"summary":"","estimatedWeeklyImpact":"£X"}';

    const aiRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }
    });

    const text = aiRes.data.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
   const jsonStart = clean.indexOf('{');
const jsonEnd = clean.lastIndexOf('}');
if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON found');
keywordState.analysis = JSON.parse(clean.substring(jsonStart, jsonEnd + 1));
    keywordState.lastAnalysed = Date.now();
    console.log('Keyword AI analysis complete');
  } catch(e) {
    console.error('Keyword analysis error: ' + e.message);
    keywordState.analysis = ruleBasedKeywordAnalysis(keywordState.data);
  }
}

function ruleBasedKeywordAnalysis(data) {
  const wasters = data.filter(function(r) {
    return parseFloat(r.cost||0) > 1 && parseInt(r.purchases14d||0) === 0;
  }).sort(function(a,b) { return parseFloat(b.cost||0) - parseFloat(a.cost||0); }).slice(0, 10);
  const converters = data.filter(function(r) {
    return parseInt(r.purchases14d||0) > 0 && r.matchType !== 'EXACT';
  }).sort(function(a,b) { return parseInt(b.purchases14d||0) - parseInt(a.purchases14d||0); }).slice(0, 10);
  const totalWasted = wasters.reduce(function(s,r){ return s + parseFloat(r.cost||0); }, 0);
  return {
    wasteReduction: {
      totalWasted: '£' + totalWasted.toFixed(2),
      topWasters: wasters.map(function(r){ return { searchTerm: r.searchTerm, campaign: r.campaignName, spend: '£' + parseFloat(r.cost||0).toFixed(2), recommendation: 'Add as negative keyword', reason: 'Zero conversions after £' + parseFloat(r.cost||0).toFixed(2) + ' spend' }; }),
      estimatedSaving: '£' + totalWasted.toFixed(2) + '/week'
    },
    newKeywords: {
      totalOpportunities: converters.length,
      topOpportunities: converters.map(function(r){ return { searchTerm: r.searchTerm, campaign: r.campaignName, purchases: r.purchases14d, sales: '£' + parseFloat(r.sales14d||0).toFixed(2), recommendation: 'Add as exact match keyword', estimatedImpact: 'Lower ACOS, more targeted traffic' }; })
    },
    bidChanges: [],
    portfolioInsights: { patterns: 'Analysis based on last 7 days of search term data', topPerforming: converters[0] ? converters[0].campaignName : 'N/A', needsAttention: wasters[0] ? wasters[0].campaignName : 'N/A' },
    summary: 'Found ' + wasters.length + ' wasting search terms and ' + converters.length + ' new keyword opportunities.',
    estimatedWeeklyImpact: '£' + totalWasted.toFixed(2) + ' saved'
  };
}

// Keyword intelligence API endpoints
app.get('/api/keywords/status', function(req, res) {
  res.json({
    reportId: keywordState.reportId,
    hasData: !!keywordState.data,
    dataSize: keywordState.data ? keywordState.data.length : 0,
    hasAnalysis: !!keywordState.analysis,
    lastAnalysed: keywordState.lastAnalysed,
    requested: keywordState.requested
  });
});

app.get('/api/keywords/analysis', function(req, res) {
  res.json({ analysis: keywordState.analysis, dataSize: keywordState.data ? keywordState.data.length : 0 });
});

app.post('/api/keywords/refresh', async function(req, res) {
  keywordState.requested = 0; // Force new request
  keywordState.reportId = null;
  await requestSearchTermReport();
  res.json({ success: true, reportId: keywordState.reportId });
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
  const campaign = state.campaigns.find(function(c) { 
    return String(c.campaignId) === String(id) || c.campaignId == id;
  });
  console.log('Budget request for id: ' + id + ', found: ' + (campaign ? campaign.name : 'NOT FOUND') + ', total campaigns: ' + state.campaigns.length);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found: ' + id });
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













