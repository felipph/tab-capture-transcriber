// Run with: node generate-icons.js
// Generates simple PNG icons using pure Node.js (no canvas dep)
// We'll create simple colored square PNGs manually

const fs = require('fs');
const path = require('path');

function createMinimalPNG(size, r, g, b) {
  // Minimal PNG: 1x1 solid color, then scale via CSS
  // Actually let's create a proper PNG header for a solid color square
  const { createCanvas } = (() => {
    try { return require('canvas'); } catch { return null; }
  })() || {};

  if (!createCanvas) {
    // Write a hardcoded tiny valid PNG (purple square placeholder)
    // This is a 1x1 blue pixel PNG in base64:
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    return png1x1;
  }

  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.roundRect(0, 0, size, size, size * 0.2);
  ctx.fill();

  // Record dot
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.25, 0, Math.PI * 2);
  ctx.fill();

  return canvas.toBuffer('image/png');
}

const sizes = [16, 48, 128];
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

sizes.forEach(size => {
  const buf = createMinimalPNG(size, 88, 101, 242); // #5865f2
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), buf);
  console.log(`Generated icon${size}.png`);
});
