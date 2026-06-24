'use strict';

/**
 * 유튜브 업로드 모듈 — 외부 의존성 없이 Node 내장 https로 동작.
 *
 * 자격 증명은 환경변수로 주입(나중에 설정):
 *   YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN
 *
 * 셋이 모두 있을 때만 활성화. refresh_token으로 access_token을 받고,
 * YouTube Data API v3 resumable 업로드로 영상을 올린다(스트리밍).
 */

const https = require('https');
const fs = require('fs');

function cfg() {
  return {
    clientId: process.env.YT_CLIENT_ID,
    clientSecret: process.env.YT_CLIENT_SECRET,
    refreshToken: process.env.YT_REFRESH_TOKEN,
  };
}

function isConfigured() {
  const c = cfg();
  return Boolean(c.clientId && c.clientSecret && c.refreshToken);
}

function postForm(host, path, form) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const req = https.request(
      {
        host,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(data); } catch (_) { /* ignore */ }
          if (res.statusCode >= 400) {
            reject(new Error((j && (j.error_description || j.error)) || ('토큰 오류 ' + res.statusCode)));
          } else if (j) resolve(j);
          else reject(new Error('토큰 응답 파싱 실패'));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const c = cfg();
  const j = await postForm('oauth2.googleapis.com', '/token', {
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: c.refreshToken,
    grant_type: 'refresh_token',
  });
  if (!j.access_token) throw new Error('access_token을 받지 못했습니다.');
  return j.access_token;
}

function startResumable(accessToken, meta, fileSize) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(meta);
    const req = https.request(
      {
        host: 'www.googleapis.com',
        path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json; charset=UTF-8',
          'Content-Length': Buffer.byteLength(body),
          'X-Upload-Content-Type': 'video/mp4',
          'X-Upload-Content-Length': fileSize,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error('업로드 시작 실패 (' + res.statusCode + '): ' + data));
          const loc = res.headers.location;
          if (!loc) return reject(new Error('업로드 세션 URL을 받지 못함'));
          resolve(loc);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function uploadBytes(uploadUrl, filePath, fileSize) {
  return new Promise((resolve, reject) => {
    const u = new URL(uploadUrl);
    const req = https.request(
      {
        host: u.host,
        path: u.pathname + u.search,
        method: 'PUT',
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': fileSize },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(data); } catch (_) { /* ignore */ }
          if (res.statusCode >= 400) {
            reject(new Error((j && j.error && j.error.message) || ('업로드 실패 ' + res.statusCode)));
          } else if (j && j.id) resolve(j);
          else reject(new Error('업로드 응답 파싱 실패'));
        });
      }
    );
    req.on('error', reject);
    fs.createReadStream(filePath).pipe(req); // 스트리밍 업로드(대용량 안전)
  });
}

/**
 * @param {{filePath, title, description, tags, privacyStatus, categoryId}} opts
 * @returns {Promise<{id, url}>}
 */
async function uploadVideo(opts) {
  if (!isConfigured()) throw new Error('YouTube 자격 증명(YT_CLIENT_ID/SECRET/REFRESH_TOKEN)이 설정되지 않았습니다.');
  if (!fs.existsSync(opts.filePath)) throw new Error('영상 파일을 찾을 수 없습니다.');
  const fileSize = fs.statSync(opts.filePath).size;
  const accessToken = await getAccessToken();
  const meta = {
    snippet: {
      title: (opts.title || 'Ambient').slice(0, 100),
      description: (opts.description || '').slice(0, 4900),
      tags: Array.isArray(opts.tags) ? opts.tags.slice(0, 30) : [],
      categoryId: opts.categoryId || '10', // 10 = Music
    },
    status: {
      privacyStatus: opts.privacyStatus || 'private', // private | unlisted | public
      selfDeclaredMadeForKids: false,
    },
  };
  const uploadUrl = await startResumable(accessToken, meta, fileSize);
  const result = await uploadBytes(uploadUrl, opts.filePath, fileSize);
  return { id: result.id, url: 'https://youtu.be/' + result.id };
}

module.exports = { isConfigured, uploadVideo };
