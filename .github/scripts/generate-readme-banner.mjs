#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

/**
 * Repository root directory.
 *
 * @type {string}
 */
const repoRoot = process.cwd();

/**
 * Input template asset paths.
 *
 * @type {{ light: string, dark: string }}
 */
const templatePaths = {
  light: path.join(repoRoot, '.github/assets/templates/readme-banner_light.jpg'),
  dark: path.join(repoRoot, '.github/assets/templates/readme-banner_dark.jpg')
};

/**
 * Output banner asset paths.
 *
 * @type {{ light: string, dark: string }}
 */
const outputPaths = {
  light: path.join(repoRoot, '.github/assets/readme-banner_light.png'),
  dark: path.join(repoRoot, '.github/assets/readme-banner_dark.png')
};

/**
 * Brand font asset paths.
 *
 * WOFF2 is preferred for compact embedding. WOFF is used as fallback.
 *
 * @type {{ woff2: string, woff: string }}
 */
const fontPaths = {
  woff2: path.join(repoRoot, '.github/assets/fonts/khand-bold.woff2'),
  woff: path.join(repoRoot, '.github/assets/fonts/khand-bold.woff')
};

/**
 * Maximum banner title width in pixels before wrapping.
 *
 * @type {number}
 */
const maxTextWidth = 760;

/**
 * Starting X position for the title block.
 *
 * @type {number}
 */
const titleX = 72;

/**
 * Starting Y position for the first line of the title block.
 *
 * @type {number}
 */
const titleY = 455;

/**
 * Maximum number of title lines to render.
 *
 * @type {number}
 */
const maxLines = 2;

/**
 * Approximate character width factor used to estimate line wrapping.
 * Khand is condensed, so this estimate is lower than a standard sans-serif.
 *
 * @type {number}
 */
const averageCharWidthFactor = 0.46;

/**
 * Banner title font size in pixels.
 *
 * @type {number}
 */
const titleFontSize = 74;

/**
 * Subtitle font size in pixels.
 *
 * @type {number}
 */
const subtitleFontSize = 20;

/**
 * Get the repository slug from environment variables.
 *
 * Priority:
 * 1. REPO_NAME
 * 2. GITHUB_REPOSITORY (owner/repo)
 * 3. current folder name
 *
 * @returns {string} Repository slug.
 */
function getRepoSlug() {
  const explicitRepoName = process.env.REPO_NAME?.trim();

  if (explicitRepoName) {
    return explicitRepoName;
  }

  const githubRepository = process.env.GITHUB_REPOSITORY?.trim();

  if (githubRepository) {
    const parts = githubRepository.split('/');
    return parts[parts.length - 1];
  }

  return path.basename(repoRoot);
}


/**
 * Convert a slug-like repository name into an uppercase display title.
 *
 * Examples:
 * - revrebel-metrics-database -> REVREBEL METRICS DATABASE
 * - hotel_triton_style -> HOTEL TRITON STYLE
 *
 * @param {string} repoSlug - Repository slug.
 * @returns {string} Human-friendly uppercase title.
 */
function formatRepoTitle(repoSlug) {
  const normalized = repoSlug
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

  return normalized.toUpperCase();
}


/**
 * Escape XML special characters for safe SVG text rendering.
 *
 * @param {string} value - Raw text value.
 * @returns {string} Escaped XML-safe string.
 */
function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Wrap title text into a fixed number of lines based on a rough width estimate.
 *
 * @param {string} title - Display title.
 * @param {number} fontSize - Font size in pixels.
 * @param {number} maxWidthPx - Max line width in pixels.
 * @param {number} lineLimit - Maximum number of lines.
 * @returns {string[]} Wrapped title lines.
 */
function wrapTitle(title, fontSize, maxWidthPx, lineLimit) {
  const words = title.split(/\s+/).filter(Boolean);
  const lines = [];
  let currentLine = '';

  /**
   * Estimate width of a text line.
   *
   * @param {string} line - Candidate line.
   * @returns {number} Estimated width in pixels.
   */
  function estimateWidth(line) {
    return line.length * fontSize * averageCharWidthFactor;
  }

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (estimateWidth(candidate) <= maxWidthPx) {
      currentLine = candidate;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      lines.push(word);
    }

    if (lines.length === lineLimit - 1) {
      break;
    }
  }

  const consumedWordsCount = lines.join(' ').split(/\s+/).filter(Boolean).length;
  const remainingWords = words.slice(consumedWordsCount);

  if (lines.length < lineLimit) {
    const finalLine = [currentLine, ...remainingWords].filter(Boolean).join(' ').trim();

    if (finalLine) {
      lines.push(finalLine);
    }
  } else if (remainingWords.length > 0) {
    lines[lineLimit - 1] = `${lines[lineLimit - 1]} ${remainingWords.join(' ')}`.trim();
  }

  return lines.slice(0, lineLimit);
}

/**
 * Read the preferred font payload for SVG embedding.
 *
 * WOFF2 is preferred, then WOFF.
 *
 * @returns {{ mimeType: string, format: string, base64: string }} Embedded font payload.
 */
function getEmbeddedFont() {
  const candidates = [
    {
      filePath: fontPaths.woff2,
      mimeType: 'font/woff2',
      format: 'woff2'
    },
    {
      filePath: fontPaths.woff,
      mimeType: 'font/woff',
      format: 'woff'
    }
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate.filePath)) {
      return {
        mimeType: candidate.mimeType,
        format: candidate.format,
        base64: fs.readFileSync(candidate.filePath).toString('base64')
      };
    }
  }

  throw new Error(
    `Missing brand font file. Expected one of: ${fontPaths.woff2} or ${fontPaths.woff}`
  );
}

/**
 * Build an SVG overlay for the banner title/subtitle.
 *
 * @param {object} options - Overlay options.
 * @param {string} options.title - Main banner title.
 * @param {string} options.subtitle - Secondary banner line.
 * @param {string} options.textColor - Main title color.
 * @param {string} options.subtitleColor - Subtitle color.
 * @param {number} options.width - Canvas width.
 * @param {number} options.height - Canvas height.
 * @param {{ mimeType: string, format: string, base64: string }} options.brandFont - Embedded font payload.
 * @returns {Buffer} SVG buffer ready for Sharp composite.
 */
function buildSvgOverlay({
  title,
  subtitle,
  textColor,
  subtitleColor,
  width,
  height,
  brandFont
}) {
  const wrappedLines = wrapTitle(title, titleFontSize, maxTextWidth, maxLines);
  const lineHeight = 82;
  const subtitleOffset = 42 + (wrappedLines.length - 1) * lineHeight;

  const titleSvg = wrappedLines
    .map((line, index) => {
      const y = titleY + index * lineHeight;

      return `
        <text
          x="${titleX}"
          y="${y}"
          font-family="RRBrand"
          font-size="${titleFontSize}"
          font-weight="700"
          letter-spacing=".95"
          fill="${textColor}"
        >${escapeXml(line)}</text>
      `;
    })
    .join('\n');

  const subtitleSvg = `
    <text
      x="${titleX}"
      y="${titleY + subtitleOffset}"
      font-family="Arial, Helvetica, sans-serif"
      font-size="${subtitleFontSize}"
      font-weight="700"
      letter-spacing="2"
      fill="${subtitleColor}"
    >${escapeXml(subtitle)}</text>
  `;

  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          @font-face {
            font-family: 'RRBrand';
            src: url("data:${brandFont.mimeType};base64,${brandFont.base64}") format("${brandFont.format}");
            font-weight: 700;
            font-style: normal;
          }
        </style>
      </defs>

      ${titleSvg}
      ${subtitleSvg}
    </svg>
  `;

  return Buffer.from(svg);
}

/**
 * Ensure the output folder exists.
 *
 * @param {string} outputFilePath - Path to the generated output file.
 * @returns {void}
 */
function ensureOutputDirectory(outputFilePath) {
  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
}

/**
 * Generate a single banner image.
 *
 * @param {object} options - Banner generation options.
 * @param {string} options.inputPath - Template file path.
 * @param {string} options.outputPath - Output file path.
 * @param {string} options.title - Repo title.
 * @param {string} options.subtitle - Subtitle text.
 * @param {string} options.textColor - Title color.
 * @param {string} options.subtitleColor - Subtitle color.
 * @param {{ mimeType: string, format: string, base64: string }} options.brandFont - Embedded font payload.
 * @returns {Promise<void>} Promise that resolves when the file is written.
 */
async function generateBanner({
  inputPath,
  outputPath,
  title,
  subtitle,
  textColor,
  subtitleColor,
  brandFont
}) {
  ensureOutputDirectory(outputPath);

  const image = sharp(inputPath);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error(`Unable to determine image size for: ${inputPath}`);
  }

  const overlay = buildSvgOverlay({
    title,
    subtitle,
    textColor,
    subtitleColor,
    width: metadata.width,
    height: metadata.height,
    brandFont
  });

  await image
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toFile(outputPath);
}

/**
 * Validate that required template files exist.
 *
 * @returns {void}
 */
function validateInputs() {
  for (const inputPath of Object.values(templatePaths)) {
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Missing template file: ${inputPath}`);
    }
  }

  if (!fs.existsSync(fontPaths.woff2) && !fs.existsSync(fontPaths.woff)) {
    throw new Error(
      `Missing font files. Expected ${fontPaths.woff2} or ${fontPaths.woff}`
    );
  }
}

/**
 * Main execution entry point.
 *
 * @returns {Promise<void>} Promise that resolves when generation completes.
 */
async function main() {
  validateInputs();

  const repoSlug = getRepoSlug();
  const repoTitle = formatRepoTitle(repoSlug);
  const subtitle = 'GITHUB REPOSITORY';
  const brandFont = getEmbeddedFont();
  
  await generateBanner({
    inputPath: templatePaths.light,
    outputPath: outputPaths.light,
    title: repoTitle,
    subtitle,
    textColor: '#1E447C',
    subtitleColor: '#1E447C',
    brandFont
  });

  await generateBanner({
    inputPath: templatePaths.dark,
    outputPath: outputPaths.dark,
    title: repoTitle,
    subtitle,
    textColor: '#F3F2ED',
    subtitleColor: '#F3F2ED',
    brandFont
  });

  process.stdout.write(`Generated README banners for: ${repoTitle}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
