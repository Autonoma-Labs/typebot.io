# Typebot Authentication Setup

You need to configure at least one authentication provider. Here are your options:

## Option 1: Email Authentication with MailHog (Recommended for Local Dev)

MailHog captures emails locally so you can test the email authentication flow.

### Setup:
```bash
# Start MailHog
docker run -d -p 1025:1025 -p 8025:8025 --name mailhog mailhog/mailhog
```

Your `.env.local` is already configured for MailHog:
- SMTP will send emails to `localhost:1025`
- View captured emails at http://localhost:8025

### Usage:
1. Start MailHog (command above)
2. Start your app: `bunx nx dev builder`
3. Go to http://localhost:3000/signin
4. Enter your email and click "Sign in"
5. Open http://localhost:8025 to see the magic link email
6. Click the link or enter the 6-digit code

---

## Option 2: Disable Email Auth (Quick Testing)

If you just want to test without email:

### Setup:
Edit `.env.local` and set:
```env
SMTP_AUTH_DISABLED=true
```

**Note:** This skips email verification but you still need another auth provider (see Option 3).

---

## Option 3: GitHub OAuth (Production-Ready)

### Setup:
1. Go to https://github.com/settings/developers
2. Click "New OAuth App"
3. Fill in:
   - Application name: `Typebot Local`
   - Homepage URL: `http://localhost:3000`
   - Authorization callback URL: `http://localhost:3000/api/auth/callback/github`
4. Click "Register application"
5. Copy the Client ID and generate a Client Secret

### Add to `.env.local`:
```env
GITHUB_CLIENT_ID=your_client_id_here
GITHUB_CLIENT_SECRET=your_client_secret_here
```

---

## Option 4: Google OAuth

### Setup:
1. Go to https://console.cloud.google.com/apis/credentials
2. Create a new OAuth 2.0 Client ID
3. Add authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
4. Copy the Client ID and Client Secret

### Add to `.env.local`:
```env
GOOGLE_AUTH_CLIENT_ID=your_client_id_here
GOOGLE_AUTH_CLIENT_SECRET=your_client_secret_here
```

---

## Current Configuration Status

Check `.env.local` - currently configured for:
- ✅ NEXTAUTH_URL: http://localhost:3000
- ✅ NEXT_PUBLIC_VIEWER_URL: http://localhost:3001
- ✅ Email auth with MailHog (pending MailHog start)

## Next Steps

1. Choose one option above
2. Restart your dev server: `bunx nx dev builder`
3. Navigate to http://localhost:3000/signin
4. You should see the configured auth provider(s)

## Troubleshooting

If you still see "You need to configure at least one auth provider":
- Ensure `.env.local` has the required variables
- Restart the dev server completely
- Check console for any error messages
