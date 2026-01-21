const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Browser instance for reuse
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--autoplay-policy=no-user-gesture-required'
      ]
    });
  }
  return browserInstance;
}

// Puppeteer를 사용해서 Sora 비디오 정보 가져오기
async function fetchFromSora(soraUrl) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  // Collect video URLs from network
  let networkVideoUrl = null;

  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';
    if ((url.includes('videos.openai.com') && url.includes('/raw')) || contentType.includes('video/mp4')) {
      networkVideoUrl = url;
    }
  });

  try {
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 720 });

    console.log(`Navigating to: ${soraUrl}`);
    await page.goto(soraUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for video element with longer timeout
    try {
      await page.waitForSelector('video', { timeout: 20000 });
      console.log('Video element found');
    } catch (e) {
      console.log('Video element not found, checking page content...');
    }

    // Wait for video src to be set
    await new Promise(r => setTimeout(r, 5000));

    // Extract video info
    const videoInfo = await page.evaluate(() => {
      const result = {
        videoUrl: null,
        thumbnailUrl: null,
        prompt: null,
        title: null
      };

      // Get video element
      const video = document.querySelector('video');
      if (video) {
        result.videoUrl = video.src || video.currentSrc;
        result.thumbnailUrl = video.poster;
      }

      // Get meta tags
      const ogDesc = document.querySelector('meta[property="og:description"]');
      const ogTitle = document.querySelector('meta[property="og:title"]');
      const ogImage = document.querySelector('meta[property="og:image"]');

      if (ogDesc) result.prompt = ogDesc.getAttribute('content');
      if (ogTitle) result.title = ogTitle.getAttribute('content');
      if (!result.thumbnailUrl && ogImage) {
        result.thumbnailUrl = ogImage.getAttribute('content');
      }

      return result;
    });

    // Use network captured URL if page extraction failed
    if (!videoInfo.videoUrl && networkVideoUrl) {
      console.log('Using network captured video URL');
      videoInfo.videoUrl = networkVideoUrl;
    }

    return videoInfo;
  } finally {
    await page.close();
  }
}

// oiioii.ai URL에서 리다이렉트된 실제 비디오 URL 가져오기
async function fetchFromOiioii(oiioiiUrl) {
  return new Promise((resolve, reject) => {
    const protocol = oiioiiUrl.startsWith('https') ? https : http;

    const req = protocol.get(oiioiiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const redirectUrl = res.headers.location;
        resolve({
          videoUrl: redirectUrl,
          thumbnailUrl: null,
          prompt: null,
          title: 'Oiioii Video'
        });
      } else if (res.statusCode === 200) {
        // 직접 비디오 URL인 경우
        resolve({
          videoUrl: oiioiiUrl,
          thumbnailUrl: null,
          prompt: null,
          title: 'Oiioii Video'
        });
      } else {
        reject(new Error(`Unexpected status code: ${res.statusCode}`));
      }
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

// API: 비디오 정보 가져오기
app.post('/api/fetch', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const isSoraUrl = url.includes('sora.chatgpt.com') || url.includes('sora.openai.com');
  const isOiioiiUrl = url.includes('api.oiioii.ai') || url.includes('oiioii.ai');

  if (!isSoraUrl && !isOiioiiUrl) {
    return res.status(400).json({
      error: 'Invalid URL. URL must be from sora.chatgpt.com, sora.openai.com, or api.oiioii.ai'
    });
  }

  try {
    console.log(`Fetching video info for: ${url}`);

    let result;
    if (isOiioiiUrl) {
      result = await fetchFromOiioii(url);
    } else {
      result = await fetchFromSora(url);
    }

    if (!result.videoUrl) {
      throw new Error('Could not find video URL');
    }

    res.json({
      success: true,
      data: {
        prompt: result.prompt,
        title: result.title,
        thumbnailUrl: result.thumbnailUrl,
        videoUrl: result.videoUrl,
      },
    });
  } catch (error) {
    console.error('Fetch error:', error.message);
    res.status(500).json({
      error: error.message,
      hint: 'The video might be private or the page failed to load.',
    });
  }
});

// 비디오 다운로드 프록시
app.get('/api/download', async (req, res) => {
  const { url, type } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter required' });
  }

  try {
    // URL is already decoded by express, don't decode again
    const targetUrl = url;
    console.log(`Downloading from: ${targetUrl.substring(0, 100)}...`);

    const protocol = targetUrl.startsWith('https') ? https : http;

    const proxyReq = protocol.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
      }
    }, (proxyRes) => {
      // Check for error response
      if (proxyRes.statusCode !== 200 && proxyRes.statusCode !== 206) {
        console.error(`Proxy received status: ${proxyRes.statusCode}`);
        res.status(proxyRes.statusCode).json({ error: `Remote server error: ${proxyRes.statusCode}` });
        return;
      }

      const contentType = proxyRes.headers['content-type'] || 'video/mp4';
      let filename = 'sora-video.mp4';

      if (type === 'thumbnail' || contentType.includes('image')) {
        filename = 'sora-thumbnail.webp';
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      if (proxyRes.headers['content-length']) {
        res.setHeader('Content-Length', proxyRes.headers['content-length']);
      }

      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy request error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download video: ' + err.message });
      }
    });

  } catch (error) {
    console.error('Download error:', error.message);
    res.status(500).json({ error: 'Failed to download video: ' + error.message });
  }
});

// 메인 페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Graceful shutdown
process.on('SIGINT', async () => {
  if (browserInstance) {
    await browserInstance.close();
  }
  process.exit();
});

app.listen(PORT, () => {
  console.log(`Sora Downloader server running at http://localhost:${PORT}`);
});
