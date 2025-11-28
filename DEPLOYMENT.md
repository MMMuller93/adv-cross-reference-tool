# Deployment Guide - Railway

## Prerequisites
- GitHub account
- Railway account (sign up at [railway.app](https://railway.app))

---

## Step 1: Push to GitHub

1. **Create a new repository on GitHub:**
   - Go to https://github.com/new
   - Name it: `adv-cross-reference-tool` (or whatever you prefer)
   - Keep it **Public** or **Private** (your choice)
   - **Don't** initialize with README (we already have one)
   - Click "Create repository"

2. **Push your code:**
   ```bash
   cd /Users/Miles/Desktop/ADV_Cross_Reference_Gemini
   git remote add origin https://github.com/YOUR_USERNAME/adv-cross-reference-tool.git
   git branch -M main
   git push -u origin main
   ```

---

## Step 2: Deploy to Railway

### Option A: Quick Deploy (Recommended)

1. Go to https://railway.app
2. Click **"Start a New Project"**
3. Select **"Deploy from GitHub repo"**
4. Choose your repository: `adv-cross-reference-tool`
5. Railway will automatically:
   - Detect Node.js
   - Run `npm install`
   - Run `npm start`
   - Assign a public URL

### Option B: Railway CLI (Advanced)

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Initialize and deploy
railway init
railway up
```

---

## Step 3: Configure (if needed)

Railway automatically sets `PORT` environment variable, which our app uses.

**No additional configuration needed!**

Your app will be live at: `https://your-app-name.up.railway.app`

---

## Step 4: Custom Domain (Optional)

1. In Railway dashboard, go to your project
2. Click **"Settings"** → **"Domains"**
3. Click **"Custom Domain"**
4. Add your domain (e.g., `advtool.yourdomain.com`)
5. Update your DNS with the provided CNAME record

---

## Monitoring & Logs

- **View logs**: Railway dashboard → "Deployments" → Click deployment
- **Redeploy**: Push to GitHub (auto-deploys on every push)
- **Rollback**: Click previous deployment → "Redeploy"

---

## Cost

- **Free tier**: $5/month credit
- Typical usage for this app: ~$3-5/month
- Scales automatically with traffic

---

## Alternative: Render

If you prefer Render over Railway:

1. Go to https://render.com
2. Click **"New +"** → **"Web Service"**
3. Connect GitHub repo
4. Settings:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Free tier** available (slower cold starts)

---

## Troubleshooting

**Port binding error:**
- Check that server.js uses `process.env.PORT || 3009`

**Build fails:**
- Ensure `package.json` has `"start": "node server.js"`

**Can't connect to Supabase:**
- Supabase credentials are in `server.js` (public anon keys, safe to commit)

**Need environment variables:**
- Railway: Dashboard → Settings → Variables
- Add key-value pairs
