const express = require('express');
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

// ClearSora 프록시 URL 생성
const CLEARSORA_PROXY = 'https://www.clearsora.com/index.php?proxy_link=';

// ClearSora API를 통해 Sora 비디오 정보 가져오기
async function fetchFromSora(soraUrl) {
  return new Promise((resolve, reject) => {
    const postData = `sora_url=${encodeURIComponent(soraUrl)}`;

    const options = {
      hostname: 'www.clearsora.com',
      port: 443,
      path: '/index.php',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.clearsora.com',
        'Referer': 'https://www.clearsora.com/',
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.success && json.data) {
            // ClearSora 프록시 URL 사용
            const videoUrl = json.data.noWatermarkUrl ? CLEARSORA_PROXY + json.data.noWatermarkUrl : null;
            const thumbnailUrl = json.data.thumbnailUrl ? CLEARSORA_PROXY + json.data.thumbnailUrl : null;

            resolve({
              videoUrl: videoUrl,
              thumbnailUrl: thumbnailUrl,
              prompt: json.data.prompt || null,
              title: null
            });
          } else {
            reject(new Error('ClearSora API returned unsuccessful response'));
          }
        } catch (e) {
          reject(new Error('Failed to parse ClearSora response'));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('ClearSora API timeout'));
    });

    req.write(postData);
    req.end();
  });
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

app.listen(PORT, () => {
  console.log(`Sora Downloader server running at http://localhost:${PORT}`);
});
