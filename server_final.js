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
  const uk = res.data.find(p => p.countryCode === 'GB' || p.countryCode === 'UK') || res.data[0];
  state.profileId = uk.profileId;
  console.log('Profile ID: ' + state.profileId);
  return state.profileId;
}

async function fetchCampaigns() {
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Amazon-Advertising-API-ClientId': process.env.AMAZON_CLIENT_ID.trim(),
    'Amazon-Advertising-API-Scope': String(profileId),
    'Content-Type': 'application/vnd.spCampaign.v3+json',
    'Accept': 'application/vnd.spCampaign.v3+json'
  };
  try {
    const res = await axios.post(
      'https://advertising-api-eu.amazon.com/sp/campaigns/list',
      { stateFilter: { include: ['ENABLED', 'PAUSED'] } },
      { headers: headers }
    );
    const campaigns = res.data.campaigns || res.data || [];
    console.log('Campaigns fetched: ' + campaigns.length);
    return campaigns.map(function(c) {
      return Object.assign({}, c, { cost: 0, attributedSales14d: 0, clicks: 0, impressions: 0 });
    });
  } catch(e) {
    console.error('Campaign fetch error: ' + e.response.status + ' ' + JSON.stringify(e.response.data));
    throw e;
  }
}

async function updateBudget(campaignId, newBudget) {
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const res = await axios.put(
    'https://advertising-api-eu.amazon.com/v2/sp/campaigns',
    [{ campaignId: campaignId, dailyBudget: newBudget }],
    {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Amazon-Advertising-API-ClientId': process.env.AMAZON_CLIENT_ID.trim(),
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': 'application/json'
      }
    }
  );
  return res.data;
}

async function sendGoogleChat(message) {
  if (!process.env.GOOGLE_CHAT_WEBHOOK) return;
  await axios.post(process.env.GOOGLE_CHAT_WEBHOOK, { text: message });
  console.log('Google Chat sent');
}

async function analyseCampaigns(campaigns) {
  const acosCritical = parseFloat(process.env.ACOS_CRITICAL_THRESHOLD || 35);
  const budgetLowPct = parseFloat(process.env.BUDGET_LOW_PERCENT || 20);
  const now = new Date();
  const timeStr = now.toTimeString().slice(0, 5);
  const dateStr = now.toDateString();

  for (var i = 0; i < campaigns.length; i++) {
    var c = campaigns[i];
    if (c.state !== 'enabled' && c.state !== 'ENABLED') continue;
    var budget = parseFloat(c.dailyBudget || c.budget || 0);
    var spend = parseFloat(c.cost || 0);
    var sales = parseFloat(c.attributedSales14d || 0);
    var acos = sales > 0 ? (spend / sales) * 100 : 0;
    var remaining = Math.max(0, budget - spend);
    var remainingPct = budget > 0 ? (remaining / budget) * 100 : 100;
    var outOfBudget = remaining <= 0.01;
    var budgetLow = remainingPct <= budgetLowPct && !outOfBudget;
    var acosHigh = acos > acosCritical && spend > 5;
    var alertType = outOfBudget ? 'out_of_budget' : acosHigh ? 'acos_high' : budgetLow ? 'budget_low' : null;
    if (!alertType) continue;

    var alreadyAlerted = state.alerts.find(function(a) {
      return a.campaignId === c.campaignId && a.date === dateStr && a.type === alertType;
    });
    if (alreadyAlerted) continue;

    var name = c.name || 'Unknown';

    if (outOfBudget) {
      var hoursLeft = (23 * 60 + 59 - now.getHours() * 60 - now.getMinutes()) / 60;
      var roas = spend > 0 ? sales / spend : 0;
      var hourly = spend / Math.max(now.getHours(), 1);
      var missed = Math.round(hourly * hoursLeft * roas);
      var msg = '⚠ *Campaign out of budget*\n\n*' + name + '*\nRan out at ' + timeStr + '\nBudget: £' + budget.toFixed(2) + '\nACOS: ' + acos.toFixed(1) + '%\nEst. missed revenue: ~£' + missed + '\n\nApprove at: ' + (process.env.DASHBOARD_URL || 'https://campaignpulse-setup-production.up.railway.app');
      await sendGoogleChat(msg);
      state.alerts.push({ campaignId: c.campaignId, name: name, type: alertType, time: timeStr, date: dateStr, budget: budget, acos: Math.round(acos * 10) / 10, missed: missed });
      state.exhaustionLog.unshift({ date: now.toLocaleDateString('en-GB'), time: timeStr, campaign: name, budget: '£' + budget.toFixed(2), acos: acos.toFixed(1) + '%', missed: '£' + missed, added: 'Pending', action: 'Pending' });
    } else if (acosHigh) {
      var msg2 = '📈 *High ACOS alert*\n\n*' + name + '*\nACOS: ' + acos.toFixed(1) + '%\nSpend: £' + spend.toFixed(2) + '\n\nReview at: ' + (process.env.DASHBOARD_URL || 'https://campaignpulse-setup-production.up.railway.app');
      await sendGoogleChat(msg2);
      state.alerts.push({ campaignId: c.campaignId, name: name, type: alertType, time: timeStr, date: dateStr, acos: Math.round(acos * 10) / 10 });
    } else if (budgetLow) {
      var msg3 = '⚡ *Budget running low*\n\n*' + name + '*\nRemaining: £' + remaining.toFixed(2) + ' (' + remainingPct.toFixed(0) + '%)\nACOS: ' + acos.toFixed(1) + '%\n\nReview at: ' + (process.env.DASHBOARD_URL || 'https://campaignpulse-setup-production.up.railway.app');
      await sendGoogleChat(msg3);
      state.alerts.push({ campaignId: c.campaignId, name: name, type: alertType, time: timeStr, date: dateStr, remaining: Math.round(remaining * 100) / 100 });
    }
  }
}

async function syncCampaigns() {
  if (state.syncing) return;
  state.syncing = true;
  console.log('Syncing at ' + new Date().toTimeString().slice(0, 8));
  try {
    var raw = await fetchCampaigns();
    var campaigns = raw.map(function(c) {
      var budget = parseFloat(c.dailyBudget || c.budget || 0);
      var spend = parseFloat(c.cost || 0);
      var sales = parseFloat(c.attributedSales14d || 0);
      var acos = sales > 0 ? Math.round((spend / sales) * 1000) / 10 : 0;
      var remaining = Math.max(0, budget - spend);
      var pct = budget > 0 ? Math.round((spend / budget) * 100) : 0;
      return {
        campaignId: c.campaignId,
        name: c.name || '',
        state: (c.state || '').toLowerCase(),
        dailyBudget: budget,
        spend: Math.round(spend * 100) / 100,
        sales: Math.round(sales * 100) / 100,
        acos: acos,
        clicks: c.clicks || 0,
        impressions: c.impressions || 0,
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

app.get('/api/dashboard', function(req, res) {
  var campaigns = state.campaigns;
  var totalRevenue = campaigns.reduce(function(s, c) { return s + (c.sales || 0); }, 0);
  var totalSpend = campaigns.reduce(function(s, c) { return s + (c.spend || 0); }, 0);
  var blendedAcos = totalRevenue > 0 ? Math.round((totalSpend / totalRevenue) * 1000) / 10 : 0;
  var active = campaigns.filter(function(c) { return c.state === 'enabled'; }).length;
  var needsAction = campaigns.filter(function(c) {
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
  var id = req.params.id;
  var amount = parseFloat(req.body.amount || 0);
  var campaign = state.campaigns.find(function(c) { return String(c.campaignId) === String(id); });
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  try {
    var newBudget = campaign.dailyBudget + amount;
    await updateBudget(id, newBudget);
    var log = state.exhaustionLog.find(function(e) { return e.campaign === campaign.name && e.action === 'Pending'; });
    if (log) { log.added = '+£' + amount; log.action = 'Budget added'; }
    await sendGoogleChat('✅ Budget approved for *' + campaign.name + '*\n+£' + amount + ' added. New budget: £' + newBudget.toFixed(2));
    syncCampaigns();
    res.json({ success: true, newBudget: newBudget });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/alerts/:campaignId/dismiss', function(req, res) {
  var id = req.params.campaignId;
  state.alerts = state.alerts.filter(function(a) { return String(a.campaignId) !== String(id); });
  res.json({ success: true });
});

var interval = process.env.POLL_INTERVAL_MINUTES || 15;
cron.schedule('*/' + interval + ' * * * *', function() { syncCampaigns(); });

var PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', function() {
  console.log('App running on port ' + PORT);
  setTimeout(function() {
    syncCampaigns().catch(function(err) { console.error('Initial sync failed:', err.message); });
  }, 3000);
});
