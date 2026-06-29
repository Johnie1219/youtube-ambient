# 🎵 AI Music Studio

코드로 **음악을 생성**하고, **영상과 합쳐 유튜브용 고화질 MP4**를 만드는 웹앱입니다. 앰비언트부터 시티팝·로파이 그루브까지.

- 🎵 **음악 생성**: [Tone.js](https://tonejs.github.io/)로 절차적 생성(24-bit WAV). 앰비언트 + 드럼·베이스 그루브 모드, **10가지 프리셋**
- 🎬 **영상 합치기**: ffmpeg(번들)로 1080p·4K MP4. **9가지 자동 배경 테마** + 내 영상/이미지 + **플레이리스트형 제목 오버레이**
- 🤖 **원클릭 자동**: 버튼 하나로 *메타데이터 → 음악 → 영상* 까지 한 번에
- ✨ **제목·해시태그·설명 자동 작성**: 무료 템플릿(기본) / 클로드 API / NAS 로컬 Ollama 중 선택(플러그형)
- 💾 **NAS 저장 + 갤러리**: 완성 영상 영구 저장, 앱에서 다시 보기·다운로드·삭제
- ▶️ **유튜브 자동 업로드**: 제목·해시태그·공개범위 입력 후 버튼 한 번
- 📱 **앱 설치(PWA)**: 안드로이드·아이폰 홈 화면에 앱으로 추가
- 🚀 **자동 배포**: 깃 push → GitHub가 이미지 빌드(GHCR) → NAS Watchtower가 자동 갱신
- 🎨 **디자인**: Apple 톤(교차 라이트/다크 타일, 단일 블루 액센트, SF Pro)

---

## 빠른 시작

### 1. 사전 준비 (한 번만)

[Node.js](https://nodejs.org/) LTS(18 이상)를 설치합니다. (설치 시 "다음 → 다음 → 완료")

### 2. 설치 & 실행

프로젝트 폴더에서 터미널(PowerShell/명령 프롬프트)을 열고:

```bash
npm install
npm start
```

콘솔에 표시되는 주소를 브라우저에서 엽니다:

```
http://localhost:5174
```

> ffmpeg는 `npm install` 시 플랫폼에 맞는 바이너리가 자동으로 함께 설치됩니다(Windows는 `ffmpeg.exe`). 따로 설치할 필요가 없습니다.

---

## 📱 휴대폰·외부에서 쓰기 (NAS 서버 배포)

NAS에 올려두면 집의 휴대폰은 물론, 밖에서도 접속해 쓸 수 있습니다. 음악 생성은 접속한 기기(휴대폰)의 브라우저에서, **무거운 MP4 합치기는 NAS가** 처리합니다.

### A. NAS에서 Docker로 실행 (자동 업데이트)

코드가 깃에 올라가면 GitHub가 자동으로 이미지를 빌드해 **GHCR**에 올리고, NAS의 **Watchtower**가 그걸 받아 자동 갱신합니다. NAS에서 직접 빌드하지 않아 빠릅니다. **처음 한 번만** 설정하면 그 뒤로는 손댈 필요 없습니다.

**최초 1회 설정**
1. GitHub 저장소 → **Packages**에서 `youtube-ambient` 패키지가 생기면(첫 Actions 빌드 후) **Package settings → Change visibility → Public** 으로 변경(인증 없이 NAS가 받도록).
2. 시놀로지 **Container Manager → 프로젝트 → 생성**:
   - 경로: 아무 폴더(예: `/docker/youtube-ambient`)
   - 원본: **docker-compose.yml 생성** → 이 저장소의 `docker-compose.yml` 내용을 붙여넣기 (이미지 기반이라 소스 파일을 NAS에 올릴 필요 없음)
   - 빌드 → 이미지를 받아 실행됩니다.
3. 접속: `http://<NAS-IP>:5174`

**그 뒤로는** 코드가 바뀔 때마다 GitHub가 빌드 → Watchtower가 2분 내 자동 교체. **수동 업로드/재빌드 불필요.**

> 로컬(노트북)에서 소스로 직접 돌리려면 `docker-compose.yml`에서 `image:` 대신 `build: .`을 쓰거나, 그냥 `npm install && npm start`.

### B. 같은 집 네트워크(Wi-Fi)에서 휴대폰으로

NAS와 같은 Wi-Fi라면 바로 됩니다: 휴대폰 브라우저에서 `http://<NAS-IP>:5174`.

### C. 밖에서(외부망) 접속 — 한 가지 고르세요

| 방법 | 장점 | 비고 |
|------|------|------|
| **Tailscale (권장)** | 포트 개방 불필요, 자동 암호화, 가장 안전·간단 | NAS와 휴대폰에 Tailscale 앱 설치 → 휴대폰에서 `http://<NAS의 Tailscale IP>:5174` |
| **NAS 리버스 프록시 + DDNS + HTTPS** | 주소 하나로 https 접속 | 시놀로지: 제어판 → 로그인 포털 → 고급 → 리버스 프록시에서 `ambient.<내도메인>.synology.me → localhost:5174`, 인증서는 Let's Encrypt 자동발급 |
| **Cloudflare Tunnel** | 포트 개방 없이 외부 공개 | `cloudflared`로 `localhost:5174` 터널링 |

> ⚠️ **외부에 열 때는 꼭 인증을 거세요.** `docker-compose.yml`에서 `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` 주석을 풀고 강력한 비밀번호로 바꾸면, 접속 시 아이디·비밀번호를 묻습니다. Tailscale을 쓰면 네트워크 자체가 비공개라 더 안전합니다.

### 🟦 시놀로지(Synology) + Tailscale 단계별 가이드

**1) 앱을 NAS에 올리고 Container Manager로 실행**

1. **Package Center**에서 **Container Manager** 설치 (DSM 7.2 이상).
2. **File Station**에서 공유 폴더에 이 저장소를 복사합니다. 예: `/docker/youtube-ambient` (Container Manager 설치 시 `docker` 공유폴더가 생깁니다).
3. **Container Manager → 프로젝트 → 생성**
   - 프로젝트 이름: `youtube-ambient`
   - 경로: 방금 복사한 폴더 선택
   - 소스: **"docker-compose.yml 사용"** (폴더 안의 파일을 자동 인식)
   - **다음 → 완료** → 이미지 빌드가 끝나면 자동 실행됩니다.
4. 같은 Wi-Fi의 휴대폰/PC에서 접속 확인: `http://<NAS-IP>:5174`

> (선택·외부공개 시 권장) 프로젝트 만들기 전에 `docker-compose.yml`의 `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` 두 줄 주석을 풀고 값을 바꿔두면 로그인 창이 생깁니다.

**2) Tailscale로 밖에서 접속 (포트 개방 불필요)**

1. NAS: **Package Center**에서 **Tailscale** 검색 후 설치 → 열어서 **로그인**(본인 계정으로 인증).
   - (검색이 안 되면 [tailscale.com/download/synology](https://tailscale.com/download/synology)에서 기종에 맞는 `.spk`를 받아 Package Center → 수동 설치)
2. 로그인하면 NAS에 Tailscale 주소가 생깁니다(예: `100.x.y.z`, 또는 MagicDNS 이름 `nas-이름`).
3. **휴대폰**: 앱스토어/플레이스토어에서 **Tailscale 앱** 설치 → **같은 계정으로 로그인**.
4. 이제 밖에서도 휴대폰 브라우저에서 접속: **`http://100.x.y.z:5174`** (또는 `http://<MagicDNS-이름>:5174`)

> Tailscale은 두 기기를 비공개 가상 네트워크로 직접 연결하므로 공유기 포트 개방·DDNS가 필요 없고, 트래픽이 자동 암호화됩니다. 가장 간단하고 안전합니다.

### 📲 휴대폰에 "앱"으로 설치하기 (홈 화면 추가)

IP 주소를 매번 칠 필요 없이, **홈 화면 아이콘**을 눌러 앱처럼 실행할 수 있습니다(안드로이드·아이폰 공통, PWA).

- **아이폰(Safari)**: 접속 주소를 연 뒤 **공유 버튼 → "홈 화면에 추가"** → 음표 아이콘이 생깁니다.
- **안드로이드(Chrome)**: 메뉴(⋮) → **"홈 화면에 추가"** / "앱 설치".

> **HTTPS면 완전한 앱처럼(전체화면·오프라인 캐시) 동작**합니다. Tailscale은 무료로 HTTPS 주소를 줍니다:
> 1. (PC에서 한 번) NAS에 SSH로 접속하거나 Tailscale 설정에서 **MagicDNS + HTTPS Certificates**를 켭니다.
> 2. NAS에서 `tailscale serve --bg 5174` 실행 → `https://<NAS이름>.<tailnet>.ts.net` 주소가 생깁니다.
> 3. 그 **https 주소**를 휴대폰에서 열고 "홈 화면에 추가" → 진짜 앱처럼 설치됩니다.
> (그냥 `http://100.x.y.z:5174`로도 홈 화면 추가는 되지만, 오프라인 캐시 등 일부 기능은 https에서만 동작합니다.)

### 모바일 사용 팁
- 음악 생성은 **휴대폰 CPU**를 쓰므로 길이는 **1~2분**을 권장합니다(앱이 자동으로 기본값을 낮춥니다). 더 긴 영상은 PC에서 만들거나 짧은 음악에 긴 영상을 합치세요.
- 일반 `http`로도 음악 생성·미리듣기·합치기가 동작합니다. 다만 보안·앱 설치를 위해 외부 접속은 위의 HTTPS(Tailscale Serve 또는 리버스 프록시)를 권장합니다.

---

## 사용법

### 가장 빠른 길 — 🤖 원클릭 자동
프리셋 하나 고르고 **"🤖 원클릭 자동"** 버튼 → *어울리는 영상 테마 선택 → 제목·해시태그·설명 자동 작성 → 음악 생성 → MP4 합치기 → NAS 저장* 까지 한 번에. 완성되면 "내 영상"에 쌓이고 유튜브로 올릴 수 있어요.

### 수동(원하면 단계별로)

**1단계 — 음악 생성**
1. **프리셋** 선택 — 앰비언트(가을 계곡·새벽 안개·드리미 신스·깊은 수면 등) + 그루브(시티 드라이브·펑키 선셋·로파이·나이트 시티)
2. **길이·시드·템포·리버브·레이어** 조절 → **🎵 음악만 생성**
   - 같은 **시드**면 멜로디·코드가 동일하게 재현됩니다(물·바람 질감만 미세하게 달라짐).

**2단계 — 영상과 합쳐 MP4 만들기**
1. **자동 배경 테마** 9종 중 선택(파일 불필요). 프리셋을 바꾸면 어울리는 테마가 자동 선택돼요.
2. (선택) **내 영상/이미지** 업로드 → 영상은 자동 루프, 이미지는 켄번스 줌
3. (선택) **제목 텍스트** 입력 → 영상 위에 플레이리스트형 큰 제목 표시
4. **제목·해시태그·설명** 입력(또는 **✨ 자동 작성**), **공개 범위** 선택
5. **해상도(1080p/4K)·프레임레이트(30/60)** → **🎬 MP4 만들기**

출력: `H.264 (yuv420p) + AAC 320k`, `+faststart` — 유튜브 업로드에 바로 적합.

출력: `H.264 (yuv420p) + AAC 320k`, `+faststart` — 유튜브 업로드에 바로 적합한 형식입니다.

---

## 동작 방식

```
[브라우저]  Tone.js 절차적 생성 ── Tone.Offline 렌더 → 24-bit WAV
                                              │ (업로드)
                                              ▼
[Node 서버] /api/render ── ffmpeg ── 영상 루프 / 이미지 켄번스 / 그라데이션
                                   └ libx264(crf 18~20) + AAC → MP4
                                              │ (SSE 진행률)
                                              ▼
                              미리보기 · 다운로드
```

신호 흐름(음악): `패드(무빙 필터+코러스) · 멜로디(핑퐁 딜레이) · 베이스 · 물/바람(밴드패스+오토팬)` → 리버브 → 리미터 → 페이드.

---

## 팁 & 한계

- **길이**: 음악은 브라우저 메모리에서 렌더되므로 1~5분을 권장합니다. 더 긴 영상이 필요하면 짧게 만든 음악에 긴 영상을 합치거나, 여러 번 만들어 이어 붙이세요.
- **4K·60fps**는 인코딩이 더 오래 걸립니다. 먼저 1080p로 확인 후 4K로 뽑는 것을 권장합니다.
- 음악 생성과 미리듣기는 인터넷 없이 동작합니다(Tone.js를 로컬에서 서빙).

## 폴더 구조

```
server.js                     Express + ffmpeg 백엔드 (합치기, SSE 진행률, 갤러리·유튜브 API)
youtube.js                    유튜브 업로드 모듈 (의존성 없이 https로 OAuth+resumable)
metadata.js                   제목·해시태그·설명 생성기 (template/claude/ollama 플러그형)
.github/workflows/            깃 push 시 멀티아치 이미지 자동 빌드(GHCR)
public/
  index.html                  UI
  styles.css
  app.js                      컨트롤 바인딩, 진행률, 다운로드
  audio/
    ambient-engine.js         Tone.js 절차적 앰비언트 엔진 + 프리셋
    wav-encoder.js            AudioBuffer → 24-bit WAV
  manifest.webmanifest        PWA 매니페스트(홈 화면 설치)
  sw.js                       서비스 워커(오프라인 캐시)
  icons/                      앱 아이콘(192·512·apple-touch)
scripts/
  make-icons.js               아이콘 생성기(의존성 없이 PNG 굽기)
Dockerfile, docker-compose.yml  NAS/서버 배포용
```

## 내 영상 저장 (NAS)

- 완성된 MP4는 **NAS에 영구 저장**됩니다(도커 named volume `ambient_output` → 컨테이너의 `OUTPUT_DIR=/data/output`). 폴더를 미리 만들 필요가 없습니다.
- 앱의 **"내 영상"** 섹션에서 저장된 영상을 다시 보고, 다운로드·삭제·유튜브 업로드할 수 있습니다.

## 유튜브 자동 업로드 연결 (나중에 한 번만)

업로드 버튼은 이미 들어 있고, **자격 증명만 채우면** 켜집니다. 영상의 제목·설명·해시태그·공개범위는 앱에서 입력한 값으로 올라갑니다.

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성 → **YouTube Data API v3** 사용 설정.
2. **OAuth 동의 화면** 구성(외부, 테스트 사용자에 본인 계정 추가) → **사용자 인증 정보 → OAuth 클라이언트 ID(데스크톱 앱)** 생성 → `client_id` / `client_secret` 확보.
3. **refresh token** 발급: [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)에서 우측 톱니 → "Use your own OAuth credentials" 체크 후 위 값 입력 → 범위 `https://www.googleapis.com/auth/youtube.upload` 선택 → 인증 → **Exchange authorization code for tokens** → `refresh_token` 복사.
4. `docker-compose.yml`의 환경변수 주석을 풀고 채운 뒤 다시 빌드:
   ```yaml
   - YT_CLIENT_ID=...apps.googleusercontent.com
   - YT_CLIENT_SECRET=...
   - YT_REFRESH_TOKEN=...
   ```

> 미인증 앱은 업로드 영상이 **비공개(private)** 로 제한될 수 있습니다(구글 정책). 먼저 비공개로 올린 뒤 유튜브 스튜디오에서 공개로 바꾸거나, 앱 인증을 받으면 공개 업로드가 가능합니다.

## 환경 변수

- `PORT` — 서버 포트 (기본 `5174`)
- `HOST` — 바인딩 주소 (기본 `0.0.0.0`, 모든 인터페이스 → LAN/원격 접속 허용)
- `OUTPUT_DIR` — 완성 영상 저장 경로 (Docker는 `/data/output` = named volume)
- `FFMPEG_PATH` — ffmpeg 실행 파일 경로 (지정 시 우선, 미지정 시 번들된 `ffmpeg-static` 사용. Docker는 `/usr/bin/ffmpeg`)
- `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` — 둘 다 설정하면 간단 Basic 인증 활성화 (외부 노출 시 권장)
- `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN` — 셋 다 설정하면 유튜브 업로드 활성화
- `PEXELS_API_KEY` 또는 `PIXABAY_API_KEY` — 설정하면 **키워드 → 실사 영상** 활성화 (무료. 둘 중 아무거나, 둘 다면 Pexels 우선)
  - Pexels: https://www.pexels.com/api/ · Pixabay: https://pixabay.com/api/docs/ (가입 시 키 즉시 표시 — 더 간편)
- `METADATA_PROVIDER` — 메타데이터 생성기: `template`(기본·무료) / `claude` / `ollama`
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` — `METADATA_PROVIDER=claude`일 때 (모델 기본 `claude-haiku-4-5-20251001`)
- `OLLAMA_URL`, `OLLAMA_MODEL` — `METADATA_PROVIDER=ollama`일 때 (NAS 로컬 AI, 예: `http://localhost:11434` / `llama3.2`)
- `FONT_PATH` — 제목 오버레이용 폰트 (Docker는 `fonts-nanum` 자동 포함)

## 키워드 → 실사 영상 배경 (Pexels)

영상 섹션의 **🎬 영상 키워드**에 단어를 넣으면, 그 키워드에 맞는 **실제 촬영(실사) 영상**을 자동으로 찾아 배경으로 씁니다.
- 무료 키가 필요합니다 (한 번만). **Pexels·Pixabay 중 아무거나** 하나:
  - **Pixabay**(더 간편): https://pixabay.com/api/docs/ — 가입하면 문서 페이지에 키가 바로 표시됨
  - **Pexels**: https://www.pexels.com/api/ — 가입 후 양식 작성하면 키 발급
  - `docker-compose.yml`의 `PIXABAY_API_KEY`(또는 `PEXELS_API_KEY`) 주석을 풀고 값 입력 → 컨테이너 재시작
- **영어 키워드가 더 정확**합니다 (`city night drive`, `rain window`, `ocean waves` 등). 한글도 됩니다.
- **미리보기** 버튼으로 어떤 영상이 잡히는지 먼저 확인할 수 있어요. 시드를 바꾸면 다른 영상이 잡힙니다.
- 키가 없거나 결과가 없으면 자동으로 **테마 그라데이션 배경**으로 대체됩니다.
- 영상 출처(Pexels·작가)는 메타데이터에 함께 저장됩니다.

## 제목·해시태그·설명 자동 작성 (AI)

영상 섹션의 **"✨ 자동 작성"** 버튼 또는 **🤖 원클릭 자동**에서 메타데이터가 자동 생성됩니다.
- 기본은 **무료 템플릿**(테마/장르 기반). 비용 0.
- 더 좋은 품질을 원하면 환경변수만 바꿔 전환:
  - **클로드 API**: `METADATA_PROVIDER=claude` + `ANTHROPIC_API_KEY` (메타데이터는 토큰이 적어 비용 매우 낮음)
  - **NAS 로컬 Ollama**: `METADATA_PROVIDER=ollama` + `OLLAMA_URL` (무료, 단 ARM·GPU 없으면 느림)
- 어떤 경우든 실패하면 **자동으로 템플릿으로 폴백**합니다.

> 참고: Claude **Max 구독(claude.ai)** 은 앱에서 직접 호출할 수 없습니다(API 키와 별개). 자동화하려면 Anthropic **API 키**가 필요해요.
