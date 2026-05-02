const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────────────────
// Public paths that don't need auth
const PUBLIC_PATHS = ['/auth/login', '/auth/logout', '/admin/create-manager'];

async function requireAuth(req, res, next) {
  // Skip auth for public paths
  if (PUBLIC_PATHS.some(function(p){ return req.path.startsWith(p); })) return next();
  // Skip auth for static assets
  if (req.path.match(/\.(css|js|png|jpg|ico|svg|woff|woff2)$/)) return next();

  const token = req.headers['x-auth-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!token) {
    // For HTML page requests, redirect to login
    if (req.path === '/' || req.path === '/index.html') {
      return res.redirect('/login.html');
    }
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    if (!db) return next(); // No DB = allow through (startup)
    const result = await db.query(
      'SELECT * FROM user_sessions WHERE token=$1 AND expires_at > NOW()',
      [token]
    );
    if (!result.rows.length) {
      if (req.path === '/' || req.path === '/index.html') return res.redirect('/login.html');
      return res.status(401).json({ error: 'Session expired' });
    }
    // Refresh session expiry on activity (24hr rolling)
    await db.query(
      "UPDATE user_sessions SET expires_at=NOW() + INTERVAL '24 hours', last_active=NOW() WHERE token=$1",
      [token]
    );
    req.user = result.rows[0];
    next();
  } catch(e) {
    console.error('Auth middleware error: ' + e.message);
    next(); // Allow through on DB error to prevent lockout
  }
}

// Serve static files FIRST (login.html, CSS, JS, images — no auth needed)
app.use(express.static(path.join(__dirname, 'public')));
// Then apply auth middleware only to API routes
app.use('/api', requireAuth);

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

// ── Google Ads State ──────────────────────────────────────────────────────
let googleState = {
  campaigns: [],
  alerts: [],
  lastSync: null,
  error: null
};

async function syncGoogleCampaigns() {
  // Google sync now handled via ingest endpoint (Google Ads Script pushes data)
  // This function is kept for compatibility but does nothing
  return;
}


// ── Google Ads Ingest Endpoint (receives data from Google Ads Script) ────
app.post('/api/google/ingest', async function(req, res) {
  // Verify secret token
  const secret = req.headers['x-google-secret'] || req.body.secret;
  const expectedSecret = process.env.GOOGLE_INGEST_SECRET || 'fksports-google-2024';
  if (secret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const campaigns = req.body.campaigns || [];
    const now = new Date();
    const ukHour = parseInt(now.toLocaleString('en-GB', {timeZone:'Europe/London', hour:'2-digit', hour12:false}));
    const alertsSuppressed = ukHour >= 22 || ukHour < 8;
    const dateStr = now.toDateString();
    const timeStr = now.toLocaleTimeString('en-GB', {timeZone:'Europe/London', hour:'2-digit', minute:'2-digit'});
    const ACOS_CRIT = parseFloat(process.env.ACOS_CRITICAL_THRESHOLD || 20);
    const BUDGET_LOW = parseFloat(process.env.BUDGET_LOW_PERCENT || 20);

    // Store campaigns in googleState
    googleState.campaigns = campaigns.map(function(c) {
      const agentName = extractAgentFromCampaign(c.name || '');
      return Object.assign({}, c, { agentName, department: 'google' });
    });
    googleState.lastSync = timeStr;
    googleState.error = null;

    console.log('Google ingest received: ' + campaigns.length + ' campaigns');

    // Save to daily snapshot
    if (db) {
      try {
        const totalSpend = campaigns.reduce(function(s,c){ return s+(parseFloat(c.spend)||0); }, 0);
        const totalRevenue = campaigns.reduce(function(s,c){ return s+(parseFloat(c.sales)||0); }, 0);
        const metrics = {
          totalSpend: totalSpend.toFixed(2),
          totalRevenue: totalRevenue.toFixed(2),
          blendedAcos: totalRevenue > 0 ? Math.round((totalSpend/totalRevenue)*100*10)/10 : 0,
          totalCampaigns: campaigns.length,
          department: 'google'
        };
        // Use a separate key for Google snapshots to avoid conflict with Amazon
        await db.query(
          "INSERT INTO app_settings (key, value) VALUES ('google_snapshot_' || TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'), $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
          [JSON.stringify({ metrics, campaigns, lastSync: timeStr })]
        );
      } catch(e) { console.error('Google snapshot error: ' + e.message); }
    }

    // Fire alerts if not suppressed
    if (!alertsSuppressed) {
      for (const c of googleState.campaigns) {
        if (c.state !== 'ENABLED' && c.state !== 'enabled') continue;
        const spend = parseFloat(c.spend || 0);
        const sales = parseFloat(c.sales || 0);
        const budget = parseFloat(c.dailyBudget || 0);
        const remaining = parseFloat(c.budgetRemaining || 0);
        const acos = sales > 0 ? Math.round((spend/sales)*100*10)/10 : 0;

        const outOfBudget = remaining <= 0.01 && budget > 0;
        const budgetLow = !outOfBudget && budget > 0 && ((remaining/budget)*100) <= BUDGET_LOW;
        const acosHigh = acos > ACOS_CRIT && spend > 1;

        let alertType = null;
        if (outOfBudget) alertType = 'out_of_budget';
        else if (acosHigh) alertType = 'acos_high';
        else if (budgetLow) alertType = 'budget_low';
        if (!alertType) continue;

        // Check if already alerted today
        const already = googleState.alerts.find(function(a) {
          return String(a.campaignId) === String(c.campaignId) && a.date === dateStr && a.type === alertType;
        });
        if (already) continue;

        googleState.alerts.push({
          campaignId: c.campaignId,
          name: c.name,
          type: alertType,
          time: timeStr,
          date: dateStr,
          acos: acos,
          budget: budget,
          department: 'google'
        });

        const dashUrl = process.env.DASHBOARD_URL || 'https://app.fksports.co.uk';
        let msg = '';
        if (alertType === 'out_of_budget') msg = '🚨 Out of Budget (Google)\n' + c.name + '\nSpent £' + spend.toFixed(2) + ' of £' + budget.toFixed(2) + '\n' + dashUrl;
        else if (alertType === 'budget_low') msg = '⚡ Budget Low (Google)\n' + c.name + '\n£' + remaining.toFixed(2) + ' remaining\n' + dashUrl;
        else if (alertType === 'acos_high') msg = '📈 High ACoS (Google)\n' + c.name + '\nACoS: ' + acos + '%\n' + dashUrl;

        const agent = c.agentName;
        if (agent) await sendToAgent(agent, msg);

        if (db) {
          try {
            await db.query(
              'INSERT INTO activity_log (campaign_id, campaign_name, agent_name, action, notes, department) VALUES ($1,$2,$3,$4,$5,$6)',
              [String(c.campaignId), c.name, agent||'Unknown', alertType, msg, 'google']
            );
          } catch(e) {}
        }
      }
    }

    res.json({ success: true, campaignsReceived: campaigns.length });
  } catch(e) {
    console.error('Google ingest error: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Google Ads Dashboard Endpoint ───────────────────────────────────────
app.get('/api/google/dashboard', async function(req, res) {
  const camps = googleState.campaigns || [];
  const alerts = googleState.alerts || [];
  const totalSpend = camps.reduce(function(s,c){ return s+(c.spend||0); }, 0);
  const totalRevenue = camps.reduce(function(s,c){ return s+(c.sales||0); }, 0);
  const blendedAcos = totalRevenue > 0 ? Math.round((totalSpend/totalRevenue)*100*10)/10 : 0;
  const outOfBudget = camps.filter(function(c){ return c.budgetRemaining <= 0.01 && c.dailyBudget > 0; }).length;
  const spendNoRevenue = camps.filter(function(c){ return c.spend > 0 && (c.sales === 0 || c.sales === null); }).length;
  res.json({
    metrics: {
      totalSpend: totalSpend.toFixed(2),
      totalRevenue: totalRevenue.toFixed(2),
      blendedAcos,
      outOfBudget,
      spendNoRevenue,
      totalCampaigns: camps.length,
      activeCampaigns: camps.filter(function(c){ return c.state === 'enabled'; }).length
    },
    campaigns: camps,
    alerts: alerts,
    lastSync: googleState.lastSync,
    error: googleState.error
  });
});

// Search term report: fetch 3x daily at 8am, 1pm, 6pm UK time
// Existing keyword data is preserved between fetches — only replaced when new data arrives
cron.schedule('0 8,13,18 * * *', function() {
  console.log('Scheduled keyword report fetch...');
  requestSearchTermReport().catch(function(e){ console.error('Scheduled KW request error: ' + e.message); });
  checkSearchTermReport().catch(function(e){ console.error('Scheduled KW check error: ' + e.message); });
}, { timezone: 'Europe/London' });

// Daily task scheduler at 8am UK time
cron.schedule('0 8 * * *', function() {
  console.log('Running scheduled daily tasks at 8am UK time');
  runDailyTaskScheduler().catch(function(e){ console.error('Scheduled task error: ' + e.message); });
}, { timezone: 'Europe/London' });

// Auto-archive cron at midnight - 3 working days after resolution
cron.schedule('0 0 * * *', function() {
  autoArchiveTasks().catch(function(e){ console.error('Auto-archive error: ' + e.message); });
}, { timezone: 'Europe/London' });

async function autoArchiveTasks() {
  if (!db) return;
  try {
    // Check for expired scaling tasks (7-day window expired)
    const expiredScaling = await db.query(
      "SELECT id, campaign_name, agent_name FROM campaign_tasks WHERE status='scaling' AND scaling_deadline IS NOT NULL AND scaling_deadline < NOW()"
    );
    for (const row of expiredScaling.rows) {
      await db.query(
        "UPDATE campaign_tasks SET status='open', updated_at=NOW() WHERE id=$1",
        [row.id]
      );
      // Log expiry to activity log
      await db.query(
        'INSERT INTO activity_log (campaign_id, campaign_name, agent_name, action, notes, status_before, status_after, task_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        ['', row.campaign_name, row.agent_name, 'scaling_expired', '7-day scaling window expired. Task returned to open for immediate action.', 'scaling', 'open', row.id]
      );
      console.log('Scaling expired for: ' + row.campaign_name);
      // Notify agent
      if (row.agent_name) {
        const dashUrl = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'https://campaignpulse-setup-production.up.railway.app';
        await sendToAgent(row.agent_name, '🚨 SCALING WINDOW EXPIRED\nCampaign: ' + row.campaign_name + '\n7-day scaling period has ended. Immediate decision required: resolve or pause.\n' + dashUrl + '/tasks');
      }
    }

    // Get all resolved tasks not yet archived
    const result = await db.query(
      "SELECT id, resolved_at FROM campaign_tasks WHERE status IN ('complete','dismissed','paused') AND archived_at IS NULL AND resolved_at IS NOT NULL"
    );
    let archived = 0;
    const now = new Date();
    for (const row of result.rows) {
      const resolved = new Date(row.resolved_at);
      // Count working days since resolution
      let workingDays = 0;
      const check = new Date(resolved);
      check.setDate(check.getDate() + 1);
      while (check <= now) {
        const day = check.getDay();
        if (day !== 0 && day !== 6) workingDays++;
        if (workingDays >= 3) break;
        check.setDate(check.getDate() + 1);
      }
      if (workingDays >= 3) {
        await db.query('UPDATE campaign_tasks SET status=$1, archived_at=NOW() WHERE id=$2', ['archived', row.id]);
        archived++;
      }
    }
    if (archived > 0) console.log('Auto-archived ' + archived + ' tasks');
  } catch(e) {
    console.error('Auto-archive error: ' + e.message);
  }
}

const interval = process.env.POLL_INTERVAL_MINUTES || 15;
cron.schedule('*/' + interval + ' * * * *', function() {
  syncCampaigns();
  syncGoogleCampaigns().catch(function(e){ console.error('Google sync error: ' + e.message); });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async function() {
  console.log('App running on port ' + PORT);
  await initDB();
  // Load saved settings from DB
  if (db) {
    try {
      const result = await db.query('SELECT settings FROM app_settings WHERE id = 1');
      const settings = result.rows[0]?.settings || {};
      if (settings.acosCritical) process.env.ACOS_CRITICAL_THRESHOLD = String(settings.acosCritical);
      if (settings.acosWarning) process.env.ACOS_WARNING_THRESHOLD = String(settings.acosWarning);
      if (settings.budgetLowPct) process.env.BUDGET_LOW_PERCENT = String(settings.budgetLowPct);
      if (Object.keys(settings).length) console.log('Settings loaded from DB: ' + JSON.stringify(settings));
    } catch(e) { console.error('Settings load error: ' + e.message); }
  }
  setTimeout(function() {
    syncCampaigns().catch(function(err) { console.error('Initial sync failed:', err.message); });
    syncGoogleCampaigns().catch(function(err) { console.error('Initial Google sync failed:', err.message); });
  }, 30000);
});













