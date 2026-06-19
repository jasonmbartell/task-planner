/**
 * Generate PNG icons from SVG sources for PWA.
 * Run: node scripts/generate-icons.mjs
 *
 * This is a one-time script. If you don't have sharp installed,
 * the SVG icons in public/ will work for most browsers.
 * Apple Touch Icon requires PNG, so this script handles that.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, '..', 'public');

async function generate() {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.log('sharp not installed. Install with: npm install -D sharp');
    console.log('SVG icons will work for most browsers without PNG conversion.');
    console.log('PNG is mainly needed for Apple Touch Icon on iOS.');
    process.exit(0);
  }

  const iconSvg = readFileSync(resolve(publicDir, 'icon.svg'));
  const maskableSvg = readFileSync(resolve(publicDir, 'icon-maskable.svg'));

  const sizes = [192, 512];

  for (const size of sizes) {
    await sharp(iconSvg)
      .resize(size, size)
      .png()
      .toFile(resolve(publicDir, `icon-${size}.png`));
    console.log(`Generated icon-${size}.png`);

    await sharp(maskableSvg)
      .resize(size, size)
      .png()
      .toFile(resolve(publicDir, `icon-maskable-${size}.png`));
    console.log(`Generated icon-maskable-${size}.png`);
  }

  // Apple Touch Icon (180x180)
  await sharp(iconSvg)
    .resize(180, 180)
    .png()
    .toFile(resolve(publicDir, 'apple-touch-icon-180.png'));
  console.log('Generated apple-touch-icon-180.png');

  console.log('\nAll icons generated successfully!');
}

generate().catch(console.error);
