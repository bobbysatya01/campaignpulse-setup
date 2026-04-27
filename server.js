const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── State ─────────────────────────────────────────────────────────────────
let state = {
  accessToken: null,
  tokenExpiry: null,
  profileId: null,
  campaigns: [],
  alerts: [],
  exhaustionLog: [],
  lastSync: null,
  syncing: false
};

// ── Token management ──────────────────────────────────────────────────────
async function getAccessToken() {
  if (state.accessToken && state.tokenExpiry && Date.now() < state.tokenExpiry - 60000) {
    return state.accessToken;
  }
  console.log('Refreshing access token...');
  const res = await axios.post('https://api.amazon.co.uk/auth/o2/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.AMAZON_REFRESH_TOKEN,
      client_id: process.env.AMAZON_CLIENT_ID,
      client_secret: process.env.AMAZON_CLIENT_SECRET
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  state.accessToken = res.data.access_token;
  state.tokenExpiry = Date.now() + (res.data.expires_in * 1000);
  console.log('Access token refreshed successfully');
  return state.accessToken;
}

// ── Get profile ID ────────────────────────────────────────────────────────
async function getProfileId() {
  if (state.profileId) return state.profileId;
  const token = await getAccessToken();
  const res = await axios.get('https://advertising-api-eu.amazon.com/v2/profiles', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': process.env.AMAZON_CLIENT_ID
    }
  });
  const profiles = res.data;
  const uk = profiles.find(p => p.countryCode === 'GB' || p.countryCode === 'UK') || profiles[0];
  state.profileId = uk.profileId;
  console.log(`Using profile: ${state.profileId} (${uk.countryCode})`);
  return state.profileId;
}

// ── Fetch campaigns ───────────────────────────────────────────────────────
async function fetchCampaignStats() {
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Amazon-Advertising-API-ClientId': process.env.AMAZON_CLIENT_ID.trim(),
    'Amazon-Advertising-API-Scope': String(profileId)
  };
  try {
    const res = await axios.get('https://advertising-api-eu.amazon.com/v2/sp/campaigns', {
      headers,
      params: { stateFilter: 'enabled,paused' }
    });
    console.log('Campaigns fetched:', JSON.stringify(res.data).substring(0, 200));
    return res.data.map(c => ({ ...c, cost: 0, attributedSales14d: 0, clicks: 0, impressions: 0 }));
  } catch(e) {
    console.error('Campaign fetch error:', e.response?.status, JSON.stringify(e.response?.data));
    throw e;
  }
}
}

// ── Update campaign budget ────────────────────────────────────────────────
async function updateBudget(campaignId, newBudget) {
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const res = await axios.put('https://advertising-api-eu.amazon.com/v2/sp/campaigns',
    [{ campaignId, dailyBudget: newBudget }],
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': process.env.AMAZON_CLIENT_ID,
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/json'
      }
    }
  );
  return res.data;
}

// ── Google Chat notification ──────────────────────────────────────────────
async function sendGoogleChat(message) {
  if (!process.env.GOOGLE_CHAT_WEBHOOK) {
    console.log('No Google Chat webhook configured');
    return;
  }
  await axios.post(process.env.GOOGLE_CHAT_WEBHOOK, { text: message });
  console.log('Google Chat notification sent');
}

// ── Analyse campaigns and fire alerts ────────────────────────────────────
async function analyseCampaigns(campaigns) {
  const acosWarning = parseFloat(process.env.ACOS_WARNING_THRESHOLD || 25);
  const acosCritical = parseFloat(process.env.ACOS_CRITICAL_THRESHOLD || 35);
  const budgetLowPct = parseFloat(process.env.BUDGET_LOW_PERCENT || 20);
  const now = new Date();
  const timeStr = now.toTimeString().slice(0, 5);

  for (const c of campaigns) {
    if (c.state !== 'enabled') continue;

    const budget = c.dailyBudget || 0;
    const spend = c.cost || 0;
    const sales = c.attributedSales14d || 0;
    const acos = sales > 0 ? (spend / sales) * 100 : 0;
    const budgetRemaining = budget - spend;
    const budgetPct = budget > 0 ? (budgetRemaining / budget) * 100 : 100;
    const isOutOfBudget = budgetRemaining <= 0.01;
    const isBudgetLow = budgetPct <= budgetLowPct && !isOutOfBudget;
    const isAcosHigh = acos > acosCritical && spend > 5;

    // Check if we already alerted for this campaign today
    const alreadyAlerted = state.alerts.find(a =>
      a.campaignId === c.campaignId &&
      a.date === now.toDateString() &&
      a.type === (isOutOfBudget ? 'out_of_budget' : isAcosHigh ? 'acos_high' : 'budget_low')
    );
    if (alreadyAlerted) continue;

    if (isOutOfBudget) {
      const estimatedMissed = estimateMissedRevenue(c, now);
      const msg = `⚠ *Campaign out of budget — action needed*\n\n*${c.name}*\nRan out of budget at ${timeStr}\nBudget was: £${budget.toFixed(2)}\nACOS at time: ${acos.toFixed(1)}%\nEstimated missed revenue: ~£${estimatedMissed}\n\nRecommended: Add £${Math.ceil(budget * 0.5)} to capture remaining demand.\n\nApprove via dashboard: ${process.env.DASHBOARD_URL || 'http://localhost:4000'}`;
      await sendGoogleChat(msg);
      state.alerts.push({ campaignId: c.campaignId, name: c.name, type: 'out_of_budget', time: timeStr, date: now.toDateString(), budget, acos, estimatedMissed });
      state.exhaustionLog.unshift({ date: now.toLocaleDateString('en-GB'), time: timeStr, campaign: c.name, budget, acos: acos.toFixed(1), estimatedMissed, budgetAdded: null, actionTaken: 'Pending', responseTime: null });
      console.log(`Alert: ${c.name} is out of budget`);
    } else if (isAcosHigh) {
      const msg = `📈 *High ACOS alert — action needed*\n\n*${c.name}*\nCurrent ACOS: ${acos.toFixed(1)}% (threshold: ${acosCritical}%)\nSpend today: £${spend.toFixed(2)}\nSales today: £${sales.toFixed(2)}\n\nReview via dashboard: ${process.env.DASHBOARD_URL || 'http://localhost:4000'}`;
      await sendGoogleChat(msg);
      state.alerts.push({ campaignId: c.campaignId, name: c.name, type: 'acos_high', time: timeStr, date: now.toDateString(), budget, acos, spend });
      console.log(`Alert: ${c.name} ACOS is ${acos.toFixed(1)}%`);
    } else if (isBudgetLow) {
      const msg = `⚡ *Budget running low*\n\n*${c.name}*\nBudget remaining: £${budgetRemaining.toFixed(2)} (${budgetPct.toFixed(0)}%)\nACOS: ${acos.toFixed(1)}%\nTime: ${timeStr}\n\nReview via dashboard: ${process.env.DASHBOARD_URL || 'http://localhost:4000'}`;
      await sendGoogleChat(msg);
      state.alerts.push({ campaignId: c.campaignId, name: c.name, type: 'budget_low', time: timeStr, date: now.toDateString(), budget, acos, budgetRemaining });
      console.log(`Alert: ${c.name} budget is low (${budgetPct.toFixed(0)}% remaining)`);
    }
  }
}

function estimateMissedRevenue(campaign, now) {
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59);
  const hoursLeft = (endOfDay - now) / (1000 * 60 * 60);
  const spend = campaign.cost || 0;
  const sales = campaign.attributedSales14d || 0;
  const roas = spend > 0 ? sales / spend : 0;
  const hourlySpend = spend / (now.getHours() || 1);
  return (hourlySpend * hoursLeft * roas).toFixed(0);
}

// ── Main sync ─────────────────────────────────────────────────────────────
async function syncCampaigns() {
  if (state.syncing) return;
  state.syncing = true;
  console.log(`Syncing campaigns at ${new Date().toTimeString().slice(0, 8)}...`);
  try {
    const campaigns = await fetchCampaignStats();
    state.campaigns = campaigns.map(c => ({
      campaignId: c.campaignId,
      name: c.name,
      state: c.state,
      dailyBudget: c.dailyBudget,
      cost: c.cost || 0,
      clicks: c.clicks || 0,
      impressions: c.impressions || 0,
      attributedSales14d: c.attributedSales14d || 0,
      acos: c.attributedSales14d > 0 ? ((c.cost / c.attributedSales14d) * 100).toFixed(1) : '0.0',
      budgetRemaining: Math.max(0, c.dailyBudget - (c.cost || 0)),
      budgetPct: c.dailyBudget > 0 ? Math.min(100, ((c.cost || 0) / c.dailyBudget) * 100).toFixed(0) : 0
    }));
    await analyseCampaigns(state.campaigns);
    state.lastSync = new Date().toISOString();
    console.log(`Sync complete. ${state.campaigns.length} campaigns loaded.`);
  } catch (e) {
    console.error('Sync error:', e.message, e.response?.data);
  } finally {
    state.syncing = false;
  }
}

// ── API Routes ────────────────────────────────────────────────────────────

// Get dashboard data
app.get('/api/dashboard', (req, res) => {
  const campaigns = state.campaigns;
  const totalRevenue = campaigns.reduce((s, c) => s + (c.attributedSales14d || 0), 0);
  const totalSpend = campaigns.reduce((s, c) => s + (c.cost || 0), 0);
  const blendedAcos = totalRevenue > 0 ? ((totalSpend / totalRevenue) * 100).toFixed(1) : '0.0';
  const needsAction = campaigns.filter(c => parseFloat(c.acos) > parseFloat(process.env.ACOS_CRITICAL_THRESHOLD || 35) || c.budgetRemaining <= 0.01 || parseFloat(c.budgetPct) >= 80).length;
  res.json({
    metrics: { totalRevenue: totalRevenue.toFixed(2), totalSpend: totalSpend.toFixed(2), blendedAcos, activeCampaigns: campaigns.filter(c => c.state === 'enabled').length, needsAction },
    campaigns,
    alerts: state.alerts.slice(0, 20),
    lastSync: state.lastSync
  });
});

// Get exhaustion report
app.get('/api/report', (req, res) => {
  res.json({ exhaustionLog: state.exhaustionLog });
});

// Approve budget increase
app.post('/api/campaigns/:id/budget', async (req, res) => {
  const { id } = req.params;
  const { amount, action } = req.body;
  try {
    const campaign = state.campaigns.find(c => c.campaignId == id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const newBudget = parseFloat(campaign.dailyBudget) + parseFloat(amount);
    await updateBudget(id, newBudget);
    // Update exhaustion log
    const logEntry = state.exhaustionLog.find(e => e.campaign === campaign.name && e.actionTaken === 'Pending');
    if (logEntry) {
      logEntry.budgetAdded = `+£${amount}`;
      logEntry.actionTaken = 'Budget added';
      logEntry.responseTime = 'Just now';
    }
    await sendGoogleChat(`✅ Budget approved for *${campaign.name}*\n+£${amount} added. New budget: £${newBudget.toFixed(2)}`);
    await syncCampaigns();
    res.json({ success: true, newBudget });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dismiss alert
app.post('/api/alerts/:campaignId/dismiss', (req, res) => {
  const { campaignId } = req.params;
  state.alerts = state.alerts.filter(a => a.campaignId != campaignId);
  const logEntry = state.exhaustionLog.find(e => e.actionTaken === 'Pending');
  if (logEntry) { logEntry.actionTaken = 'Dismissed'; logEntry.budgetAdded = 'None'; }
  res.json({ success: true });
});

// Manual sync trigger
app.post('/api/sync', async (req, res) => {
  syncCampaigns();
  res.json({ success: true, message: 'Sync started' });
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await getAccessToken();
    res.json({ status: 'ok', lastSync: state.lastSync, campaigns: state.campaigns.length });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Scheduler ─────────────────────────────────────────────────────────────
const interval = process.env.POLL_INTERVAL_MINUTES || 15;
cron.schedule(`*/${interval} * * * *`, () => { syncCampaigns(); });

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`App running on port ${PORT}`);

  // start background sync AFTER app starts
  setTimeout(() => {
    syncCampaigns().catch(err =>
      console.error('Initial sync failed:', err.message)
    );
  }, 3000);
});
