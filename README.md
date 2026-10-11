# Deploy PocketLab on Vercel (no command line)

1. Make a free GitHub account, click New repository, then "uploading an existing file" and drag in ALL files and folders from this zip (index.html, api/, lib/, vercel.json). Commit.
2. Go to vercel.com, sign in with GitHub, click Add New > Project, pick your repo, and click Deploy. It works immediately in sample mode (no AI images).
3. To turn on live images: Vercel project > Settings > Environment Variables. Add:
   IMAGE_PROVIDER (openai-compatible or custom), IMAGE_API_KEY, IMAGE_MODEL, and optionally IMAGE_BASE_URL and IMAGE_SIZE.
   Then Deployments > the latest one > Redeploy.
4. Sponsor API with a different shape: edit lib/providers.js (custom function) right in GitHub's web editor, commit, and Vercel redeploys itself.
Check your provider's docs for model names, sizes and response format before relying on the openai-compatible adapter.
Note: the API route sets a 60-second limit; if your Vercel plan allows less, slow generations will time out.
