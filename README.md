# 自动听写 · 拍照出词，念给孩子听

一个**网页版轻应用（PWA）**：把课本上的词语拍下来（或上传图片），自动识别中文、拼音和英文，然后按你设置的**次数**和**间隔**播报给孩子听写。

- 完全在**本机浏览器**里运行，拍照识别与数据都保存在这台设备上，**不经过任何服务器**。
- 可**离线使用**（Service Worker 缓存了页面和识别模型），可"添加到主屏幕"当 App 用。
- 零成本：不需要注册账号、不需要 API Key。

---

## 功能一览

**第 1 步 · 拍照识别**
- 直接拍照 / 从相册选择 / 拖入 / 粘贴截图，一次可传多张。
- 内置 Tesseract.js 本地识别（中文简体 + 英文模型已内置，首次使用也无需联网）。
- 自动对照片做缩放、灰度、对比度拉伸、二值化，提升书本照片识别率。

**第 2 步 · 核对词语（识别不准也能改）**
- 中文字词自动标拼音（多音字按常见读音，可手动改）。
- 每行可改：中文、拼音、英文、例句/组词；可设置"这一个词念几遍"。
- 支持批量粘贴、把词"拆成单字"、"与上一个合并"、打乱顺序。
- 自动识别按"拼音/英文是天然分隔符"切分；连续汉字视为一个词，可手动拆合。

**第 3 步 · 开始听写**
- 每个词：中文念 N 遍 / 英文念 N 遍，内容可选（念中文/拼音/英文/例句）。
- **词内间隔**（同一个词两次朗读之间）和**词间停顿**（留给孩子书写的秒数）分别设置。
- 语速、中文/英文音色可选（用系统自带语音，可离线）。
- 开始可加倒计时、可打乱顺序、可先报序号、结束时响提示音。
- 播放中可**暂停 / 继续 / 跳过 / 重听 / 从某个词开始**；大字号显示当前进度。
- **无声练习模式**：没有语音引擎（或你不想听机器念）时，照常按节奏走，屏幕大字提示当前该写哪个词，家长自己念。
- "看答案（家长模式）"开关。

**听写本**
- 自动保存历史项目，可重命名、删除、继续编辑。

---

## 技术栈

- [Vite](https://vitejs.dev/) + 原生 JS（无框架，体量小）
- [tesseract.js](https://github.com/naptha/tesseract.js)（本地 OCR，中/英模型已内置）
- [pinyin-pro](https://pinyin-pro.cn)（汉字 → 带声调拼音）
- [vite-plugin-pwa](https://vite-pwa-org.netlify.app/)（离线缓存 / 可安装）
- 浏览器 Web Speech API（TTS 朗读）

---

## 本地开发

需要 Node.js 18+。

```bash
npm install        # 安装依赖
npm run dev        # 启动开发服务器，浏览器打开 http://localhost:5173
```

> 首次安装依赖时，可选的 `copy-tesseract-assets` 与 `make-icons` 脚本会把 OCR 运行时和图标放进 `public/`。

## 构建与预览

```bash
npm run build      # 产物输出到 dist/
npm run preview    # 本地预览构建产物 http://localhost:4173
```

把 `dist/` 目录里面的文件上传到任意静态托管（GitHub Pages、Nginx、对象存储等）即可上线；
项目用的是相对路径，放到子目录也能正常用。

## 测试

```bash
npm test           # 运行单元测试（解析 / 拼音 / 播报排程）
```

浏览器端冒烟验证（自动起无头 Chrome，截屏 + 校验状态机）：

```bash
npm run build && node scripts/verify.mjs
# 截图保存在 verification/ 目录
```

---

## 使用小贴士

- 拍课本时光线均匀、手机放平在 20~30cm 外，识别率更高。
- 识别不准很正常——第 2 步每个字都能手改，改完点"标拼音"即自动生成拼音。
- 手机浏览器里点"添加到主屏幕"，之后像 App 一样打开，**断网也能用**。
- Windows 无中文语音可在「设置 → 时间和语言 → 语音」添加中文语音包；手机一般在系统语音设置里下载。
- 在微信里打开时可用"在浏览器中打开"以获得完整功能（微信内置浏览器可能限制语音合成）。

---

## 主要目录

```
index.html                  入口页面
vite.config.js              Vite + PWA 配置
src/
  core/                    纯逻辑（可单测，不依赖 DOM）
    text.js                 字符判断 / 空白归一化
    model.js                数据集 / 设置模型与校验
    parser.js               OCR 文本解析 → 词条
    pinyin.js               汉字标拼音
    scheduler.js            播报排程（念几遍、隔多久）
    speech.js               TTS 播放器（暂停/跳过/重听/无声模式）
    storage.js              localStorage + IndexedDB
    ocr.js                  Tesseract 识别 + 图片预处理
  ui/
    state.js                全局状态
    photos.js  words.js  play.js  library.js  settings.js
    utils.js                轻量 DOM 工具
  main.js  styles.css
public/
  tessdata/                中英文识别模型（离线）
  tesseract/                OCR 运行时（离线）
  icons/                    PWA 图标
tests/                      单元测试
scripts/                    copy/make-icons/verify 工具脚本
```