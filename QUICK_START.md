# Widget Customization - Quick Start Guide

## 🚀 How It Works

Your users customize the widget through the **API**, and then they only need to paste a **single line of code** on their website. No manual configuration needed!

```html
<!-- Single Line - That's All! -->
<script src="http://localhost:3053/api/v1/embed/wk_YOUR_WIDGET_KEY.js"></script>
```

---

## 📋 Quick Test Steps

### 1. Start Your Server
```bash
npm run dev
```

### 2. Login & Get JWT Token
```bash
# Login
curl -X POST http://localhost:3053/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "your-email@example.com",
    "password": "your-password"
  }'

# Save the JWT token from response
```

### 3. Create Widget with Customization
```bash
curl -X POST http://localhost:3053/api/auth/widget/create \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "widgetName": "My Awesome Chat",
    "widgetConfig": {
      "primaryText": "**Hey there!** How can I help you today?",
      "bannerText": "Support Chat",
      "bannerColor": "#4A90E2",
      "sendColor": "#FF6B6B",
      "floatingBtn": "#4ECDC4",
      "userChatColor": "#E8F5E9",
      "autoOpen": true,
      "logoIcon": "https://via.placeholder.com/150"
    }
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "Widget key created successfully",
  "data": {
    "widgetKey": "wk_abc123xyz...",
    "embedCode": "<script src=\"http://localhost:3053/api/v1/embed/wk_abc123xyz....js\"></script>"
  }
}
```

### 4. Copy Your Embed Code
From the response above, copy the `embedCode`.

### 5. Test the Widget
Create a test HTML file:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Widget Test</title>
</head>
<body>
  <h1>My Website</h1>
  <p>The chat widget will appear in the bottom right.</p>

  <!-- Paste your embed code here -->
  <script src="http://localhost:3053/api/v1/embed/wk_YOUR_WIDGET_KEY.js"></script>
</body>
</html>
```

Open this file in your browser and you'll see the widget with your custom colors!

### 6. Update Customization (Anytime!)
```bash
curl -X PUT http://localhost:3053/api/auth/widget/update \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "widgetConfig": {
      "bannerColor": "#FF5733",
      "sendColor": "#00AA00",
      "bannerText": "Updated Support"
    }
  }'
```

Changes take effect immediately (cache may take up to 1 hour to refresh).

---

## 🎨 Customization UI

For a visual customization interface, open:
```
http://localhost:3053/widget/customization-example.html
```

This gives you a beautiful dashboard to:
- ✅ Configure all colors visually
- ✅ Set text content
- ✅ Upload logo
- ✅ Generate API requests
- ✅ Copy embed code

---

## 📚 Available Customization Options

| Option | Type | Example |
|--------|------|---------|
| `primaryText` | string | `"**Welcome!** Ask me anything"` |
| `bannerText` | string | `"Support Chat"` |
| `bannerTextColor` | string | `"#1B73CC"` |
| `bannerColor` | string | `"#CDCFD1"` |
| `bannerTextParagraph` | string | `"Powered by AI"` |
| `bannerTextParagraphColor` | string | `"#999999"` |
| `sendColor` | string | `"#B82E12"` |
| `floatingBtn` | string | `"#4ECDC4"` |
| `userChatColor` | string | `"#E8F5E9"` |
| `closeButtonColor` | string | `"#F527EE"` |
| `logoIcon` | string | `"https://example.com/logo.png"` |
| `autoOpen` | boolean | `true` |
| `chatVoiceIconColor` | string | `"#7908FB"` (future) |
| `voiceSendButton` | string | `"#7908FB"` (future) |

---

## 🔑 API Endpoints Summary

### Create Widget
```
POST /api/auth/widget/create
```

### Get Widget Info
```
GET /api/auth/widget/key
```

### Update Widget
```
PUT /api/auth/widget/update
```

### Delete Widget
```
DELETE /api/auth/widget/delete
```

### Regenerate Key
```
POST /api/auth/widget/regenerate
```

### Get Embed Script (Public)
```
GET /api/v1/embed/{widgetKey}.js
```

---

## 🎯 Best Practices

1. **Store Widget Key Securely** - It's like an API key for your widget
2. **Use Domain Restrictions** - Prevent unauthorized use
3. **Test Before Deploying** - Use the test HTML page
4. **Update Through API** - Don't manually edit website code
5. **Monitor Analytics** - Track widget usage and performance

---

## 🐛 Troubleshooting

### Widget not loading?
```bash
# Check if widget exists
curl http://localhost:3053/api/auth/widget/key \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Chat not working?
1. Open browser console (F12)
2. Look for errors
3. Verify widget key is correct
4. Check webhook endpoint is accessible

### Customization not showing?
1. Clear browser cache
2. Wait up to 1 hour for cache to refresh
3. Hard refresh: Ctrl + Shift + R

---

## 🚢 Production Deployment

Set environment variable:
```env
WIDGET_API_URL=https://your-production-domain.com
```

Your embed code will automatically use production URL:
```html
<script src="https://your-production-domain.com/api/v1/embed/wk_abc123.js"></script>
```

---

## 📖 Full Documentation

See [WIDGET_CUSTOMIZATION.md](./WIDGET_CUSTOMIZATION.md) for complete API documentation and examples.

---

## ✨ Features

✅ **Single-line embed** - Easiest possible integration
✅ **API-driven customization** - No code changes needed
✅ **Real-time updates** - Change appearance instantly
✅ **Domain restrictions** - Security built-in
✅ **Analytics tracking** - Monitor usage
✅ **Session management** - Persistent conversations
✅ **Markdown support** - Rich text in messages
✅ **Auto-open option** - Engage users automatically

---

Happy Chatting! 🎉
