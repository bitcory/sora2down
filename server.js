const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ClearSora API를 통해 비디오 정보 가져오기
async function fetchFromClearSora(soraUrl) {
  try {
    const response = await axios.post(
      'https://www.clearsora.com/index.php',
      `sora_url=${encodeURIComponent(soraUrl)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Origin': 'https://www.clearsora.com',
          'Referer': 'https://www.clearsora.com/',
        },
        timeout: 30000,
      }
    );

    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(`ClearSora API error: ${error.response.status}`);
    }
    throw error;
  }
}

// Base64 디코딩 (ClearSora의 URL 형식)
function decodeVideoUrl(encoded) {
  if (!encoded) return null;
  try {
    // ClearSora는 특수한 인코딩을 사용하는 것 같음
    // 직접 Base64 디코딩 시도
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    // URL 형식인지 확인
    if (decoded.startsWith('http')) {
      return decoded;
    }
    // 아니면 원본 반환 (프록시에서 처리)
    return encoded;
  } catch (e) {
    return encoded;
  }
}

// API: 비디오 정보 가져오기
app.post('/api/fetch', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!url.includes('sora.chatgpt.com') && !url.includes('sora.openai.com')) {
    return res.status(400).json({
      error: 'Invalid Sora URL. URL must be from sora.chatgpt.com or sora.openai.com'
    });
  }

  try {
    console.log(`Fetching video info for: ${url}`);
    const result = await fetchFromClearSora(url);

    if (!result.success) {
      throw new Error(result.error || 'Failed to fetch video info');
    }

    res.json({
      success: true,
      data: {
        prompt: result.data.prompt,
        viewCount: result.data.viewCount,
        likeCount: result.data.likeCount,
        thumbnailUrl: result.data.thumbnailUrl,
        originalVideoUrl: result.data.originalVideoUrl,
        noWatermarkUrl: result.data.noWatermarkUrl,
        gifUrl: result.data.gifUrl,
        mdVideoUrl: result.data.mdVideoUrl,
      },
    });
  } catch (error) {
    console.error('Fetch error:', error.message);
    res.status(500).json({
      error: error.message,
      hint: 'The video might be private or the service is temporarily unavailable.',
    });
  }
});

// 비디오 다운로드 프록시 (ClearSora proxy_link 사용)
app.get('/api/download', async (req, res) => {
  const { token, type } = req.query;

  if (!token) {
    return res.status(400).json({ error: 'Token parameter required' });
  }

  try {
    // ClearSora의 다운로드 URL 구성 (proxy_link 형식)
    const downloadUrl = `https://www.clearsora.com/index.php?proxy_link=${encodeURIComponent(token)}`;

    console.log(`Downloading from: ${downloadUrl}`);

    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.clearsora.com/',
        'Accept': '*/*',
      },
      responseType: 'stream',
      timeout: 120000,
      maxRedirects: 10,
    });

    const contentType = response.headers['content-type'] || 'video/mp4';
    let filename = 'sora-video.mp4';

    if (type === 'gif' || contentType.includes('gif')) {
      filename = 'sora-video.gif';
    } else if (type === 'thumbnail' || contentType.includes('image')) {
      filename = 'sora-thumbnail.jpg';
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    response.data.pipe(res);
  } catch (error) {
    console.error('Download error:', error.message);
    res.status(500).json({ error: 'Failed to download video: ' + error.message });
  }
});

// 직접 URL 프록시
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter required' });
  }

  try {
    const response = await axios({
      method: 'GET',
      url: decodeURIComponent(url),
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Referer': 'https://sora.chatgpt.com/',
      },
      responseType: 'stream',
      timeout: 120000,
    });

    res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="sora-video.mp4"');

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    response.data.pipe(res);
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({ error: 'Failed to proxy video' });
  }
});

// 메인 페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Sora Downloader server running at http://localhost:${PORT}`);
});
