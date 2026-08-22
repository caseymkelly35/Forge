# FORGE

This is the real, standalone version of the FORGE app — built to run as an
actual website instead of inside Claude's sandboxed artifact preview, so it
can talk to the real Supabase backend (auth, cloud-synced History and
Templates).

## Deploy this for free (no command line needed)

**Step 1 — Put this code on GitHub**
1. Go to [github.com](https://github.com) and create a free account if you don't have one
2. Click the **+** in the top right → **New repository**
3. Name it `forge` (or anything you like), leave it Public, click **Create repository**
4. On the new repo's page, click **"uploading an existing file"**
5. Drag in every file and folder from this project *except* `node_modules` and `dist` (they won't exist yet anyway if you haven't run anything locally)
6. Scroll down, click **Commit changes**

**Step 2 — Deploy it with Vercel**
1. Go to [vercel.com](https://vercel.com) and sign up free — choose **"Continue with GitHub"** so the two are connected automatically
2. Click **Add New → Project**
3. Find the `forge` repository you just created and click **Import**
4. Vercel will auto-detect it's a Vite project — leave all settings as default
5. Click **Deploy**
6. Wait about a minute — you'll get a real live URL like `forge-yourname.vercel.app`

That URL is a real website. Open it, and Create Account / Sign In should work for real, because it's no longer running inside Claude's sandboxed preview.

## If something goes wrong

Send me the exact error text and which step you were on — deployment hiccups are normal and fixable, not a sign anything is fundamentally broken.
