# Deploy CampaignPulse to Railway (Free)

## Step 1 — Create a GitHub account (free, no credit card)
1. Go to github.com
2. Click Sign up
3. Choose the FREE plan

## Step 2 — Upload the code to GitHub
1. Go to github.com/new
2. Repository name: campaignpulse
3. Set to Private
4. Click Create repository
5. Click "uploading an existing file"
6. Upload ALL files from this folder
7. Click Commit changes

## Step 3 — Deploy to Railway (free)
1. Go to railway.app
2. Click "Start a New Project"
3. Click "Deploy from GitHub repo"
4. Connect your GitHub account
5. Select the campaignpulse repository
6. Railway automatically deploys it

## Step 4 — Add your credentials (the important bit)
In Railway dashboard:
1. Click your project
2. Click "Variables" tab
3. Add each of these one by one:

   AMAZON_CLIENT_ID = amzn1.application-oa2-client.db5315dce1004430a56e6d6bd7e0b75c
   AMAZON_CLIENT_SECRET = (your secret)
   AMAZON_REFRESH_TOKEN = (your Atzr| token)
   GOOGLE_CHAT_WEBHOOK = (your webhook URL)
   DASHBOARD_URL = (Railway will give you this URL after deploy)
   POLL_INTERVAL_MINUTES = 15
   ACOS_WARNING_THRESHOLD = 25
   ACOS_CRITICAL_THRESHOLD = 35
   BUDGET_LOW_PERCENT = 20

4. Railway automatically restarts with new variables

## Step 5 — Open your dashboard
Railway gives you a URL like: https://campaignpulse-production.up.railway.app
Open it in your browser — your live dashboard is ready.

## That's it
- Campaigns sync every 15 minutes automatically
- Google Chat alerts fire when action is needed
- Dashboard shows live data 24/7
- No maintenance needed
