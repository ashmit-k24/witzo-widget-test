/**
 * Witzo Chat Widget — Development Entry Point
 *
 * Import this file as an ES module in your HTML:
 *   <script type="module" src="./src/index.js"></script>
 *
 * For a single-file production embed, use the pre-built witzo-chat.js instead.
 */
import { WitzoChatWidget } from './widget.js';

if (!customElements.get('witzo-chat')) {
  customElements.define('witzo-chat', WitzoChatWidget);
}
