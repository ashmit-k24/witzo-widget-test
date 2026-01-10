# Widget Customization Guide

This guide explains how to customize your Witzo Chat Widget using the API. Users only need to embed a **single line of code** - all customization is managed through the API and stored in the database.

---

## How It Works

1. **Create or Update Widget** - Use the API to customize your widget colors, text, logo, etc.
2. **Get Embed Code** - API returns a single-line script tag
3. **Embed on Website** - Paste the script tag anywhere on your website
4. **Widget Loads with Your Customization** - The widget automatically applies your saved settings

---

## API Endpoints

### 1. Create Widget Key (First Time)

**Endpoint:** `POST /api/auth/widget/create`

**Headers:**
```json
{
  "Authorization": "Bearer YOUR_JWT_TOKEN",
  "Content-Type": "application/json"
}
```

**Request Body:**
```json
{
  "widgetName": "My Chat Widget",
  "allowedDomains": ["example.com", "*.mydomain.com"],
  "widgetConfig": {
    "primaryText": "**Hey there, I'm Merlin Chat**\nGot questions about Zycus? Ask me anything!",
    "bannerText": "Merlin Chat",
    "bannerTextColor": "#1B73CC",
    "bannerColor": "#CDCFD1",
    "bannerTextParagraph": "I am AI powered and learning",
    "bannerTextParagraphColor": "#999999",
    "sendColor": "#B82E12",
    "floatingBtn": "#B82E12",
    "userChatColor": "#CDCFD1",
    "closeButtonColor": "#F527EE",
    "logoIcon": "https://www.zycus.com/wp-content/uploads/2025/01/zycus-new-logo-190x38.webp",
    "autoOpen": true,
    "chatVoiceIconColor": "#7908FB",
    "voiceSendButton": "#7908FB"
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Widget key created successfully",
  "data": {
    "widgetKey": "wk_abc123...",
    "widgetName": "My Chat Widget",
    "allowedDomains": ["example.com"],
    "widgetConfig": { ... },
    "embedCode": "<script src=\"http://localhost:3053/api/v1/embed/wk_abc123....js\"></script>"
  }
}
```

---

### 2. Update Widget Configuration

**Endpoint:** `PUT /api/auth/widget/update`

**Headers:**
```json
{
  "Authorization": "Bearer YOUR_JWT_TOKEN",
  "Content-Type": "application/json"
}
```

**Request Body:**
```json
{
  "widgetConfig": {
    "bannerText": "Updated Chat Title",
    "bannerColor": "#FF5733",
    "sendColor": "#00FF00",
    "autoOpen": false
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Widget key updated successfully",
  "data": {
    "widgetKey": "wk_abc123...",
    "widgetName": "My Chat Widget",
    "isActive": true,
    "widgetConfig": { ... },
    "embedCode": "<script src=\"http://localhost:3053/api/v1/embed/wk_abc123....js\"></script>"
  }
}
```

---

### 3. Get Current Widget Configuration

**Endpoint:** `GET /api/auth/widget/key`

**Headers:**
```json
{
  "Authorization": "Bearer YOUR_JWT_TOKEN"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "widgetKey": "wk_abc123...",
    "widgetName": "My Chat Widget",
    "isActive": true,
    "allowedDomains": ["example.com"],
    "widgetConfig": { ... },
    "usageCount": 1234,
    "lastUsedAt": "2025-01-10T12:00:00Z",
    "createdAt": "2025-01-01T12:00:00Z",
    "embedCode": "<script src=\"http://localhost:3053/api/v1/embed/wk_abc123....js\"></script>"
  }
}
```

---

## Widget Configuration Options

All these options go in the `widgetConfig` object:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `primaryText` | string | null | Welcome message (supports markdown like `**bold**`) |
| `bannerText` | string | "Text Chat" | Header title text |
| `bannerTextColor` | string | "#ffffff" | Header title text color |
| `bannerColor` | string | "#120b14" | Header background color |
| `bannerTextParagraph` | string | "I am AI powered and learning" | Footer text in input area |
| `bannerTextParagraphColor` | string | "#999999" | Footer text color |
| `botColor` | string | "#fc0e3f" | Legacy bot color (use bannerColor instead) |
| `sendColor` | string | "#fc0e3f" | Send button background color |
| `floatingBtn` | string | "#fc0e3f" | Floating button background color |
| `floatingBtnColor` | string | "#fc0e3f" | Alternative floating button color |
| `userChatColor` | string | "#d01137ff" | User message bubble background color |
| `closeButtonColor` | string | "#ffffff" | Close button icon color |
| `logoIcon` | string | null | URL to custom logo image (displays in header) |
| `autoOpen` | boolean | false | Auto-open chat after 5 seconds |
| `chatVoiceIconColor` | string | "#7908FB" | Voice icon color (future feature) |
| `voiceSendButton` | string | "#7908FB" | Voice send button color (future feature) |

---

## Single-Line Embed Code

After creating or updating your widget, you'll receive a single-line embed code:

```html
<script src="http://localhost:3053/api/v1/embed/wk_YOUR_WIDGET_KEY.js"></script>
```

### How It Works

1. When the script loads, it:
   - Creates a `<witzo-chat>` element
   - Sets the `widget-key` attribute
   - Applies all your saved customization from the database
   - Loads the widget component library

2. The widget automatically:
   - Fetches your config from the database
   - Applies all colors, text, and settings
   - Connects to the webhook endpoint

### Example: Complete Integration

```html
<!DOCTYPE html>
<html>
<head>
  <title>My Website</title>
</head>
<body>
  <h1>Welcome to My Website</h1>

  <!-- Your content here -->

  <!-- Witzo Chat Widget - Single Line! -->
  <script src="http://localhost:3053/api/v1/embed/wk_YOUR_WIDGET_KEY.js"></script>
</body>
</html>
```

That's it! The widget will load with all your customizations.

---

## Example: Full Customization Workflow

### Step 1: Create Widget with Full Customization

```bash
curl -X POST http://localhost:3053/api/auth/widget/create \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "widgetName": "Zycus Support Chat",
    "allowedDomains": ["zycus.com", "*.zycus.com"],
    "widgetConfig": {
      "primaryText": "**Hey there, I'\''m Merlin Chat**\nGot questions about Zycus? Ask me anything and I'\''ll provide you with the info you'\''re looking for.",
      "bannerText": "Merlin Chat",
      "bannerTextColor": "#1B73CC",
      "bannerColor": "#CDCFD1",
      "sendColor": "#B82E12",
      "floatingBtn": "#B82E12",
      "userChatColor": "#E8F4FD",
      "closeButtonColor": "#F527EE",
      "logoIcon": "https://www.zycus.com/wp-content/uploads/2025/01/zycus-new-logo-190x38.webp",
      "autoOpen": true,
      "chatVoiceIconColor": "#7908FB",
      "voiceSendButton": "#7908FB"
    }
  }'
```

### Step 2: Copy the Embed Code

From the response, copy the `embedCode`:

```html
<script src="http://localhost:3053/api/v1/embed/wk_abc123xyz....js"></script>
```

### Step 3: Paste on Your Website

Add it to your website's HTML, preferably before the closing `</body>` tag.

### Step 4: Update Anytime

Change your widget's appearance without touching your website code:

```bash
curl -X PUT http://localhost:3053/api/auth/widget/update \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "widgetConfig": {
      "bannerColor": "#FF5733",
      "sendColor": "#00AA00",
      "bannerText": "Updated Support Chat"
    }
  }'
```

The changes take effect immediately (with cache refresh - up to 1 hour).

---

## Benefits of This Approach

✅ **Single Line of Code** - Easiest possible integration
✅ **Centralized Control** - Update widget appearance from your dashboard
✅ **No Code Changes** - Modify widget without redeploying your website
✅ **Version Control** - Widget script updates automatically
✅ **Security** - Widget key verification and domain restrictions
✅ **Analytics** - Track widget usage and interactions

---

## Advanced Features

### Domain Restrictions

Control where your widget can be used:

```json
{
  "allowedDomains": [
    "example.com",           // Exact domain
    "*.example.com",         // All subdomains
    "app.mysite.com"         // Specific subdomain
  ]
}
```

### Widget Activation/Deactivation

```bash
curl -X PUT http://localhost:3053/api/auth/widget/update \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isActive": false}'
```

### Regenerate Widget Key

If your key is compromised:

```bash
curl -X POST http://localhost:3053/api/auth/widget/regenerate \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## Troubleshooting

### Widget Not Loading?

1. Check browser console for errors
2. Verify your widget key is active: `GET /api/auth/widget/key`
3. Check domain restrictions
4. Verify the API URL is correct

### Customization Not Showing?

1. Clear browser cache (widget config cached for up to 1 hour)
2. Verify config saved: `GET /api/auth/widget/key`
3. Check browser dev tools for applied styles

### Chat Not Working?

1. Verify `widget-key` is correct
2. Check webhook endpoint is accessible
3. Review server logs for errors
4. Ensure you have active conversations remaining in your plan

---

## Production Deployment

When deploying to production:

1. Update `WIDGET_API_URL` environment variable:
   ```env
   WIDGET_API_URL=https://your-domain.com
   ```

2. Your embed code will automatically use the production URL:
   ```html
   <script src="https://your-domain.com/api/v1/embed/wk_YOUR_KEY.js"></script>
   ```

3. Widget will connect to production webhook:
   ```
   https://your-domain.com/api/v1/webhook
   ```

---

## Next Steps

1. Create your widget using the API
2. Customize colors and text to match your brand
3. Get the single-line embed code
4. Paste it on your website
5. Test the chat functionality
6. Monitor analytics and usage

For support, contact: support@witzo.ai
