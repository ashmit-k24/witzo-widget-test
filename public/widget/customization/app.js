'use strict';

// ── Sync color pickers ↔ text inputs ────────────────────────────
document.querySelectorAll('input[type="color"]').forEach(picker => {
  const textInput = document.getElementById(picker.id.replace('Picker', ''));
  if (!textInput) return;

  picker.addEventListener('input',  (e) => { textInput.value = e.target.value.toUpperCase(); });
  textInput.addEventListener('input', (e) => {
    if (/^#[0-9A-F]{6}$/i.test(e.target.value)) picker.value = e.target.value;
  });
});

// ── Read current form values ─────────────────────────────────────
function getFormConfig() {
  return {
    primaryText:               document.getElementById('primaryText').value,
    bannerText:                document.getElementById('bannerText').value,
    bannerTextColor:           document.getElementById('bannerTextColor').value,
    bannerColor:               document.getElementById('bannerColor').value,
    bannerTextParagraph:       document.getElementById('bannerTextParagraph').value,
    bannerTextParagraphColor:  document.getElementById('bannerTextParagraphColor').value,
    sendColor:                 document.getElementById('sendColor').value,
    floatingBtn:               document.getElementById('floatingBtn').value,
    userChatColor:             document.getElementById('userChatColor').value,
    closeButtonColor:          document.getElementById('closeButtonColor').value,
    logoIcon:                  document.getElementById('logoIcon').value || null,
    autoOpen:                  document.getElementById('autoOpen').checked,
  };
}

// ── Save configuration (calls API in production) ─────────────────
function saveConfiguration() {
  const widgetName = document.getElementById('widgetName').value;
  const config     = getFormConfig();

  console.log('Widget Configuration:', { widgetName, widgetConfig: config });

  /*
  // Production API call:
  const response = await fetch('http://localhost:3053/api/auth/widget/update', {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer YOUR_JWT_TOKEN', 'Content-Type': 'application/json' },
    body: JSON.stringify({ widgetName, widgetConfig: config })
  });
  const data = await response.json();
  if (data.success) document.getElementById('embedCodeBlock').textContent = data.data.embedCode;
  */

  alert('Configuration saved!\n(Connect to your API in production)');
  generateEmbedCode();
}

// ── Generate and display updated embed / API example ─────────────
function generateEmbedCode() {
  const config     = getFormConfig();
  const widgetName = document.getElementById('widgetName').value;
  const example    = `// Create or update widget
const response = await fetch('http://localhost:3053/api/auth/widget/update', {
  method: 'PUT',
  headers: { 'Authorization': 'Bearer YOUR_JWT_TOKEN', 'Content-Type': 'application/json' },
  body: JSON.stringify({
    widgetName: '${widgetName}',
    widgetConfig: ${JSON.stringify(config, null, 4)}
  })
});
const data = await response.json();
console.log('Embed Code:', data.data.embedCode);`;

  document.getElementById('apiRequestExample').textContent = example;
  alert('API request example updated — scroll down to see it.');
}

// ── Copy embed code to clipboard ─────────────────────────────────
function copyEmbedCode() {
  const code = document.getElementById('embedCodeBlock').textContent;
  navigator.clipboard.writeText(code).then(() => alert('Embed code copied!'));
}

// Expose to inline onclick handlers
window.saveConfiguration = saveConfiguration;
window.generateEmbedCode = generateEmbedCode;
window.copyEmbedCode     = copyEmbedCode;
