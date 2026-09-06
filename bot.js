require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const { chromium } = require('playwright');
const fetch = require('node-fetch');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, collection, addDoc, query, where, getDocs, updateDoc, doc } = require('firebase-admin/firestore');

/* =========================================================================
 * FIREBASE INITIALIZATION
 * ========================================================================= */

let db = null;
try {
  if (process.env.FIREBASE_CREDENTIALS) {
    const firebaseCredentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    initializeApp({
      credential: cert(firebaseCredentials),
    });
    db = getFirestore();
    console.log('✅ Firebase Firestore conectado');
  }
} catch (err) {
  console.warn('⚠️ Firebase não configurado. Usando apenas JSON local.');
}

/* =========================================================================
 * CONSTANTS & ENVIRONMENT VARIABLES
 * ========================================================================= */

const CONFIG_PATH = path.join(__dirname, 'config.json');
const COOKIES_PATH = path.join(__dirname, 'cookies.json');
const FINGERPRINTS_PATH = path.join(__dirname, 'fingerprints.json');
const LOGS_PATH = path.join(__dirname, 'logs');

const PORT = process.env.PORT || 3000;
const SITE_LOGIN_URL = process.env.SITE_LOGIN_URL || '';
const SITE_USER_SELECTOR = process.env.SITE_USER_SELECTOR || '';
const SITE_PASS_SELECTOR = process.env.SITE_PASS_SELECTOR || '';
const SITE_SUBMIT_SELECTOR = process.env.SITE_SUBMIT_SELECTOR || '';
const SITE_USER = process.env.SITE_USER || '';
const SITE_PASS = process.env.SITE_PASS || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const PROXY_URL = process.env.PROXY_URL || '';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY || '';
const CAPTCHA_SERVICE = process.env.CAPTCHA_SERVICE || '2captcha'; // 2captcha, anticaptcha

// Criar diretório de logs
if (!fs.existsSync(LOGS_PATH)) {
  fs.mkdirSync(LOGS_PATH, { recursive: true });
}

// User-Agents realistas
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
];

const TIMEZONES = [
  'America/Sao_Paulo',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
];

const LOCALES = ['pt-BR', 'en-US', 'en-GB', 'de-DE', 'ja-JP'];

/* =========================================================================
 * FIRESTORE HELPER
 * ========================================================================= */

class FirestoreHelper {
  async saveRun(data) {
    if (!db) return null;
    try {
      const ref = await addDoc(collection(db, 'bot_runs'), {
        ...data,
        timestamp: new Date().toISOString(),
      });
      return ref.id;
    } catch (err) {
      console.error('Erro ao salvar em Firestore:', err.message);
      return null;
    }
  }

  async getRuns(limit = 50) {
    if (!db) return [];
    try {
      const q = query(collection(db, 'bot_runs'));
      const snapshot = await getDocs(q);
      return snapshot.docs.slice(-limit).reverse().map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (err) {
      console.error('Erro ao buscar runs:', err.message);
      return [];
    }
  }

  async saveFinding(finding) {
    if (!db) return null;
    try {
      const ref = await addDoc(collection(db, 'findings'), {
        ...finding,
        timestamp: new Date().toISOString(),
      });
      return ref.id;
    } catch (err) {
      console.error('Erro ao salvar finding:', err.message);
      return null;
    }
  }

  async getFindingsByKeyword(keyword) {
    if (!db) return [];
    try {
      const q = query(collection(db, 'findings'), where('keyword', '==', keyword));
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (err) {
      console.error('Erro ao buscar findings:', err.message);
      return [];
    }
  }
}

/* =========================================================================
 * CAPTCHA SOLVER
 * ========================================================================= */

class CaptchaSolver {
  async solve2Captcha(captchaType, siteKey, pageUrl, onLog) {
    if (!CAPTCHA_API_KEY) {
      onLog('⚠️ Chave 2Captcha não configurada');
      return null;
    }

    try {
      onLog(`🤖 Resolvendo ${captchaType} com 2Captcha...`);

      const uploadUrl = 'http://2captcha.com/in.php';
      const params = new URLSearchParams({
        key: CAPTCHA_API_KEY,
        method: captchaType === 'recaptcha_v2' ? 'userrecaptcha' : 'hcaptcha',
        googlekey: siteKey,
        pageurl: pageUrl,
        json: 1,
      });

      const uploadResponse = await fetch(`${uploadUrl}?${params}`, { timeout: 10000 });
      const uploadData = await uploadResponse.json();

      if (!uploadData.captcha) {
        onLog(`❌ Erro ao enviar captcha: ${uploadData.error}`);
        return null;
      }

      const captchaId = uploadData.captcha;
      onLog(`✅ Captcha enviado: ${captchaId}. Aguardando resolução...`);

      // Poll para resultado
      const resultUrl = 'http://2captcha.com/res.php';
      let attempts = 0;
      const maxAttempts = 60; // 5 minutos

      while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 5000)); // 5s delay
        attempts++;

        const resultParams = new URLSearchParams({
          key: CAPTCHA_API_KEY,
          action: 'get',
          captcha: captchaId,
          json: 1,
        });

        const resultResponse = await fetch(`${resultUrl}?${resultParams}`, { timeout: 10000 });
        const resultData = await resultResponse.json();

        if (resultData.status === 1) {
          onLog(`✅ Captcha resolvido: ${resultData.request.substring(0, 50)}...`);
          return resultData.request;
        }

        if (resultData.status === 0 && resultData.request !== 'CAPCHA_NOT_READY') {
          onLog(`❌ Erro captcha: ${resultData.request}`);
          return null;
        }

        onLog(`⏳ Tentativa ${attempts}/${maxAttempts}...`);
      }

      onLog('❌ Timeout ao resolver captcha');
      return null;
    } catch (err) {
      onLog(`❌ Erro 2Captcha: ${err.message}`);
      return null;
    }
  }

  async solveAntiCaptcha(captchaType, siteKey, pageUrl, onLog) {
    if (!CAPTCHA_API_KEY) {
      onLog('⚠️ Chave AntiCaptcha não configurada');
      return null;
    }

    try {
      onLog(`🤖 Resolvendo ${captchaType} com AntiCaptcha...`);

      const createTaskUrl = 'https://api.anti-captcha.com/createTask';
      const taskType = captchaType === 'recaptcha_v2' ? 'NoCaptchaTaskProxyless' : 'HCaptchaTaskProxyless';

      const createResponse = await fetch(createTaskUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: CAPTCHA_API_KEY,
          task: {
            type: taskType,
            websiteURL: pageUrl,
            websiteKey: siteKey,
          },
          softId: 0,
          languagePool: 'pt',
        }),
        timeout: 10000,
      });

      const createData = await createResponse.json();

      if (!createData.taskId) {
        onLog(`❌ Erro AntiCaptcha: ${createData.errorDescription}`);
        return null;
      }

      const taskId = createData.taskId;
      onLog(`✅ Tarefa criada: ${taskId}. Aguardando...`);

      // Poll resultado
      const getResultUrl = 'https://api.anti-captcha.com/getTaskResult';
      let attempts = 0;
      const maxAttempts = 60;

      while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 5000));
        attempts++;

        const resultResponse = await fetch(getResultUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientKey: CAPTCHA_API_KEY,
            taskId: taskId,
          }),
          timeout: 10000,
        });

        const resultData = await resultResponse.json();

        if (resultData.solution?.gRecaptchaResponse) {
          onLog(`✅ Captcha resolvido: ${resultData.solution.gRecaptchaResponse.substring(0, 50)}...`);
          return resultData.solution.gRecaptchaResponse;
        }

        if (resultData.isReady) {
          onLog(`❌ Erro resolução: ${resultData.errorDescription}`);
          return null;
        }

        onLog(`⏳ Tentativa ${attempts}/${maxAttempts}...`);
      }

      onLog('❌ Timeout');
      return null;
    } catch (err) {
      onLog(`❌ Erro AntiCaptcha: ${err.message}`);
      return null;
    }
  }

  async solveCaptcha(captchaType, siteKey, pageUrl, onLog) {
    if (CAPTCHA_SERVICE === '2captcha') {
      return this.solve2Captcha(captchaType, siteKey, pageUrl, onLog);
    } else if (CAPTCHA_SERVICE === 'anticaptcha') {
      return this.solveAntiCaptcha(captchaType, siteKey, pageUrl, onLog);
    }
    return null;
  }
}

/* =========================================================================
 * FINGERPRINT GENERATOR
 * ========================================================================= */

class FingerprintGenerator {
  constructor() {
    this.fingerprints = this.loadFingerprints();
  }

  loadFingerprints() {
    try {
      if (fs.existsSync(FINGERPRINTS_PATH)) {
        return JSON.parse(fs.readFileSync(FINGERPRINTS_PATH, 'utf-8'));
      }
    } catch (err) {
      DEBUG_MODE && console.warn('Erro ao carregar fingerprints:', err.message);
    }
    return [];
  }

  saveFingerprints() {
    fs.writeFileSync(FINGERPRINTS_PATH, JSON.stringify(this.fingerprints, null, 2), 'utf-8');
  }

  generate() {
    const randomElement = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const viewport = randomElement(VIEWPORTS);

    const fingerprint = {
      id: randomUUID(),
      userAgent: randomElement(USER_AGENTS),
      viewport,
      timezone: randomElement(TIMEZONES),
      locale: randomElement(LOCALES),
      platform: randomElement(['Win32', 'MacIntel', 'Linux x86_64']),
      hardwareConcurrency: randomElement([2, 4, 6, 8]),
      deviceMemory: randomElement([4, 8, 16]),
      screenColorDepth: randomElement([24, 32]),
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      plugins: this.generatePlugins(),
      languages: [randomElement(LOCALES)],
      doNotTrack: randomElement([null, '1']),
      createdAt: new Date().toISOString(),
    };

    this.fingerprints.push(fingerprint);
    this.saveFingerprints();
    return fingerprint;
  }

  generatePlugins() {
    return [
      { name: 'Chrome PDF Plugin', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', description: '' },
      { name: 'Native Client Executable', description: '' },
    ];
  }

  getOrCreate() {
    if (this.fingerprints.length > 0) {
      return this.fingerprints[this.fingerprints.length - 1];
    }
    return this.generate();
  }
}

/* =========================================================================
 * SESSION & COOKIES MANAGER
 * ========================================================================= */

class SessionManager {
  constructor() {
    this.cookies = this.loadCookies();
  }

  loadCookies() {
    try {
      if (fs.existsSync(COOKIES_PATH)) {
        return JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
      }
    } catch (err) {
      DEBUG_MODE && console.warn('Erro ao carregar cookies:', err.message);
    }
    return [];
  }

  saveCookies(cookies) {
    this.cookies = cookies;
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2), 'utf-8');
  }

  async applyCookies(page) {
    if (this.cookies.length > 0) {
      try {
        await page.context().addCookies(this.cookies);
        DEBUG_MODE && console.log(`✅ ${this.cookies.length} cookies restaurados.`);
      } catch (err) {
        DEBUG_MODE && console.warn('Erro ao aplicar cookies:', err.message);
      }
    }
  }

  async extractCookies(page) {
    const cookies = await page.context().cookies();
    this.saveCookies(cookies);
    DEBUG_MODE && console.log(`💾 ${cookies.length} cookies salvos.`);
    return cookies;
  }
}

/* =========================================================================
 * CONFIG STORE
 * ========================================================================= */

const DEFAULT_CONFIG = {
  site: {
    loginUrl: SITE_LOGIN_URL,
    userSelector: SITE_USER_SELECTOR,
    passSelector: SITE_PASS_SELECTOR,
    submitSelector: SITE_SUBMIT_SELECTOR,
    acceptSelector: '',
    successSelector: '',
    successUrlPattern: '',
    pagesToVisit: [],
    waitForLoadState: 'networkidle',
  },
  humanize: {
    minDelayMs: 800,
    maxDelayMs: 2200,
    minScrollDelay: 300,
    maxScrollDelay: 900,
    minTypeDelay: 60,
    maxTypeDelay: 160,
  },
  cloudflare: {
    maxWaitTime: 60000,
    checkInterval: 1000,
  },
  stealth: {
    enabled: true,
    maskWebdriver: true,
    maskChromeRuntime: true,
  },
  captcha: {
    enabled: Boolean(CAPTCHA_API_KEY),
    service: CAPTCHA_SERVICE,
  },
  tasks: [],
  telegram: {
    enabled: Boolean(TELEGRAM_BOT_TOKEN),
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  monitoring: {
    enabled: true,
    screenshotOnError: true,
    logNetworkTraffic: false,
  },
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      saveConfig(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (err) {
    DEBUG_MODE && console.warn('Erro ao carregar config:', err.message);
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/* =========================================================================
 * HUMANIZATION ENGINE
 * ========================================================================= */

class HumanizationEngine {
  constructor(config) {
    this.config = config.humanize || DEFAULT_CONFIG.humanize;
  }

  randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async wait(page, minMs = null, maxMs = null) {
    const min = minMs || this.config.minDelayMs;
    const max = maxMs || this.config.maxDelayMs;
    const t = this.randomBetween(min, max);
    await page.waitForTimeout(t);
  }

  async type(page, selector, text, opts = {}) {
    const { minDelay = this.config.minTypeDelay, maxDelay = this.config.maxTypeDelay } = opts;
    try {
      await page.click(selector);
      await this.wait(page, 100, 300);

      for (const char of text) {
        await page.type(selector, char, {
          delay: this.randomBetween(minDelay, maxDelay),
        });
      }
    } catch (err) {
      DEBUG_MODE && console.warn(`Erro ao digitar em ${selector}:`, err.message);
    }
  }

  async scroll(page, steps = 4) {
    try {
      for (let i = 0; i < steps; i++) {
        await page.mouse.wheel(0, this.randomBetween(200, 500));
        await this.wait(page, this.config.minScrollDelay, this.config.maxScrollDelay);
      }
    } catch (err) {
      DEBUG_MODE && console.warn('Erro ao scroll:', err.message);
    }
  }

  async moveMouse(page, times = 3) {
    try {
      for (let i = 0; i < times; i++) {
        const x = this.randomBetween(100, 1200);
        const y = this.randomBetween(100, 700);
        await page.mouse.move(x, y);
        await this.wait(page, 200, 500);
      }
    } catch (err) {
      DEBUG_MODE && console.warn('Erro ao mover mouse:', err.message);
    }
  }

  async randomClick(page, selector) {
    try {
      const element = await page.$(selector);
      if (element) {
        await element.hover();
        await this.wait(page, 200, 400);
        await element.click();
      }
    } catch (err) {
      DEBUG_MODE && console.warn(`Erro ao clicar em ${selector}:`, err.message);
    }
  }
}

/* =========================================================================
 * CLOUDFLARE & ANTI-DETECTION
 * ========================================================================= */

class CloudflareBypass {
  constructor(config) {
    this.config = config.cloudflare || DEFAULT_CONFIG.cloudflare;
  }

  async waitForCloudflare(page, onLog) {
    const startTime = Date.now();
    const maxWait = this.config.maxWaitTime;

    onLog('⏳ Aguardando Cloudflare...');

    try {
      await page.waitForFunction(
        () => {
          const text = document.body?.innerText || '';
          return !text.toLowerCase().includes('just a moment') &&
                 !text.toLowerCase().includes('please wait') &&
                 !text.toLowerCase().includes('enabling browser integrity check');
        },
        { timeout: maxWait }
      );

      const elapsed = Date.now() - startTime;
      onLog(`✅ Cloudflare bypass realizado em ${elapsed}ms`);
    } catch (err) {
      onLog(`⚠️ Timeout Cloudflare: ${err.message}`);
    }
  }

  async injectStealth(page) {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(window, 'chrome', { get: () => ({ runtime: {} }) });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'en-US'] });
      
      if (!navigator.permissions) {
        navigator.permissions = { query: async () => ({ state: Notification.permission }) };
      }

      // Ocultar automação
      window.navigator.chrome.runtime.sendMessage = undefined;
      window.devtools = { open: false };
      Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight });
      Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });

      // Mock Playwright
      if (navigator.userAgent.includes('HeadlessChrome')) {
        Object.defineProperty(navigator, 'userAgent', {
          get: () => navigator.userAgent.replace('HeadlessChrome', 'Chrome'),
        });
      }
    });
  }

  async injectCaptchaBypass(page, onLog) {
    await page.addInitScript(() => {
      window.__recaptcha_override = true;
      window.__hcaptcha_override = true;
    });

    onLog('🛡️ Scripts de captcha injetados');
  }
}

/* =========================================================================
 * KEYWORD ENGINE
 * ========================================================================= */

function findOccurrences(text, keyword) {
  const regex = new RegExp(keyword.trim(), 'gi');
  const matches = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    const start = Math.max(0, m.index - 60);
    const end = Math.min(text.length, m.index + keyword.length + 60);
    matches.push(text.slice(start, end).replace(/\s+/g, ' ').trim());
    if (matches.length >= 5) break;
  }
  return matches;
}

async function runTasksOnPage(pageResult, tasks, handlers, db) {
  const { notifyTelegram = async () => {}, log = () => {}, page = null } = handlers;
  const sortedTasks = [...tasks].sort((a, b) => a.order - b.order);
  const findings = [];

  for (const task of sortedTasks) {
    const occurrences = findOccurrences(pageResult.text, task.keyword);
    if (occurrences.length === 0) continue;

    findings.push({ taskId: task.id, keyword: task.keyword, occurrences });
    log(`🔎 Palavra-chave "${task.keyword}" encontrada em ${pageResult.url} (${occurrences.length}x)`);

    // Salvar em Firestore
    if (db) {
      await new FirestoreHelper().saveFinding({
        keyword: task.keyword,
        url: pageResult.url,
        occurrences: occurrences[0],
        taskId: task.id,
        runId: handlers.runId,
      });
    }

    switch (task.action) {
      case 'notify_telegram': {
        const msg = `🔔 *${task.keyword}*\n📄 ${pageResult.url}\n📝 "${occurrences[0]}"`;
        await notifyTelegram(msg);
        break;
      }

      case 'visit_url': {
        if (page && task.param) {
          log(`↪️ Navegando: ${task.param}`);
          try {
            await page.goto(task.param, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise((r) => setTimeout(r, 1000));
          } catch (err) {
            log(`⚠️ Erro ao visitar ${task.param}: ${err.message}`);
          }
        }
        break;
      }

      case 'click_selector': {
        if (page && task.param) {
          log(`🖱️ Clicando: ${task.param}`);
          try {
            await page.click(task.param, { timeout: 5000 });
            await new Promise((r) => setTimeout(r, 500));
          } catch (err) {
            log(`⚠️ Erro ao clicar: ${err.message}`);
          }
        }
        break;
      }

      case 'take_screenshot': {
        if (page && task.param) {
          log(`📸 Capturando: ${task.param}`);
          try {
            const fileName = `screenshot-${Date.now()}.png`;
            const filePath = path.join(__dirname, 'screenshots', fileName);
            if (!fs.existsSync(path.join(__dirname, 'screenshots'))) {
              fs.mkdirSync(path.join(__dirname, 'screenshots'), { recursive: true });
            }
            await page.screenshot({ path: filePath });
            log(`✅ Screenshot salvo: ${fileName}`);
          } catch (err) {
            log(`⚠️ Erro ao capturar: ${err.message}`);
          }
        }
        break;
      }

      case 'extract_data': {
        if (page && task.param) {
          log(`📊 Extraindo dados de: ${task.param}`);
          try {
            const data = await page.$$eval(task.param, (elements) =>
              elements.map((el) => ({
                text: el.innerText,
                href: el.getAttribute('href'),
              }))
            );
            log(`✅ ${data.length} elementos extraídos`);
          } catch (err) {
            log(`⚠️ Erro ao extrair: ${err.message}`);
          }
        }
        break;
      }

      case 'log':
      default:
        break;
    }
  }

  return findings;
}

/* =========================================================================
 * TELEGRAM NOTIFICATIONS
 * ========================================================================= */

async function sendTelegramAlert(botToken, chatId, message) {
  if (!botToken || !chatId) {
    return { ok: false, skipped: true };
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
      }),
      timeout: 10000,
    });

    const data = await response.json();
    return data;
  } catch (err) {
    DEBUG_MODE && console.warn('Erro Telegram:', err.message);
    return { ok: false, error: err.message };
  }
}

/* =========================================================================
 * MAIN SCRAPER BOT
 * ========================================================================= */

class ScraperBot {
  constructor() {
    this.humanizer = new HumanizationEngine(loadConfig());
    this.cloudflareBypass = new CloudflareBypass(loadConfig());
    this.sessionManager = new SessionManager();
    this.fingerprintGen = new FingerprintGenerator();
    this.captchaSolver = new CaptchaSolver();
  }

  async launch() {
    const fingerprint = this.fingerprintGen.getOrCreate();
    const proxyUrl = PROXY_URL ? { server: PROXY_URL } : undefined;

    const browser = await chromium.launch({
      headless: false,
      slowMo: 300,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await browser.newContext({
      userAgent: fingerprint.userAgent,
      viewport: fingerprint.viewport,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezone,
      ignoreHTTPSErrors: true,
      javaScriptEnabled: true,
      proxy: proxyUrl,
    });

    return { browser, context, fingerprint };
  }

  async loginAndScrape(config, onLog = () => {}) {
    const { browser, context, fingerprint } = await this.launch();
    const page = await context.newPage();
    const result = { success: false, message: '', pages: [], fingerprint };

    await this.sessionManager.applyCookies(page);

    if (config.stealth?.enabled) {
      await this.cloudflareBypass.injectStealth(page);
      await this.cloudflareBypass.injectCaptchaBypass(page, onLog);
    }

    // Event listeners
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        DEBUG_MODE && console.log(`❌ Console Error: ${msg.text()}`);
      }
    });

    try {
      onLog(`🌐 Abrindo ${config.site.loginUrl}`);
      onLog(`📱 User-Agent: ${fingerprint.userAgent}`);

      await page.goto(config.site.loginUrl, {
        waitUntil: config.site.waitForLoadState || 'domcontentloaded',
        timeout: 30000,
      });

      await this.humanizer.wait(page, 1500, 3000);
      await this.humanizer.moveMouse(page, 2);

      // Aceitar cookies
      if (config.site.acceptSelector) {
        try {
          onLog('🍪 Procurando aviso de cookies...');
          if (await page.$(config.site.acceptSelector)) {
            onLog('✅ Clicando em aceitar cookies');
            await this.humanizer.randomClick(page, config.site.acceptSelector);
            await this.humanizer.wait(page, 800, 1500);
          }
        } catch (err) {
          // continuar
        }
      }

      // Aguardar Cloudflare
      try {
        await this.cloudflareBypass.waitForCloudflare(page, onLog);
      } catch (err) {
        onLog(`⚠️ ${err.message}`);
      }

      // Detectar e resolver CAPTCHA
      try {
        const hasRecaptcha = await page.$('iframe[src*="recaptcha"]') !== null;
        const hasHcaptcha = await page.$('iframe[src*="hcaptcha"]') !== null;

        if (hasRecaptcha || hasHcaptcha) {
          const captchaType = hasRecaptcha ? 'recaptcha_v2' : 'hcaptcha';
          const siteKey = await page.evaluate(() => {
            const el = document.querySelector('[data-sitekey]') || document.querySelector('iframe[src*="recaptcha"]');
            return el?.getAttribute('data-sitekey') || new URL(el?.src || '').searchParams.get('k');
          });

          if (siteKey && CAPTCHA_API_KEY) {
            const token = await this.captchaSolver.solveCaptcha(captchaType, siteKey, page.url(), onLog);
            if (token) {
              await page.evaluate((t) => {
                if (window.grecaptcha) {
                  window.grecaptcha.callback(t);
                }
              }, token);
              onLog('✅ Token de captcha injetado');
              await this.humanizer.wait(page, 1000, 2000);
            }
          }
        }
      } catch (err) {
        onLog(`⚠️ Erro ao resolver captcha: ${err.message}`);
      }

      // LOGIN
      onLog('🔐 Realizando login...');
      await this.humanizer.type(page, config.site.userSelector, SITE_USER);
      await this.humanizer.wait(page, 400, 800);

      await this.humanizer.type(page, config.site.passSelector, SITE_PASS);
      await this.humanizer.wait(page, 500, 1000);

      onLog('📝 Enviando formulário...');

      if (config.site.successUrlPattern) {
        const regex = new RegExp(config.site.successUrlPattern);
        await Promise.all([
          page.click(config.site.submitSelector),
          page.waitForURL(regex, { timeout: 30000 }).catch(() => {}),
        ]);
      } else {
        await Promise.all([
          page.click(config.site.submitSelector),
          page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}),
        ]);

        if (config.site.successSelector) {
          try {
            await page.waitForSelector(config.site.successSelector, { timeout: 15000 });
          } catch (err) {
            onLog(`⚠️ Seletor não encontrado`);
          }
        }
      }

      result.success = true;
      result.message = 'Login realizado com sucesso';
      onLog(`✅ Login bem-sucedido. URL: ${page.url()}`);

      // Salvar cookies
      await this.sessionManager.extractCookies(page);

      // Página após login
      if (config.site.successUrlPattern) {
        await this.humanizer.wait(page, 1000, 2000);
        await this.humanizer.scroll(page, 3);

        const title = await page.title();
        const text = await page.evaluate(() => document.body?.innerText || '');
        result.pages.push({
          url: page.url(),
          title,
          text: text.trim(),
        });
        onLog(`📄 "${title}" (${text.length} chars)`);
      }

      // Visitar páginas
      for (const url of config.site.pagesToVisit || []) {
        try {
          onLog(`🔗 Visitando: ${url}`);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.humanizer.wait(page, 1000, 2500);
          await this.humanizer.scroll(page, 3);

          const title = await page.title();
          const text = await page.evaluate(() => document.body?.innerText || '');
          result.pages.push({ url, title, text: text.trim() });
          onLog(`📄 "${title}" (${text.length} chars)`);
        } catch (err) {
          onLog(`❌ Erro em ${url}: ${err.message}`);
          result.pages.push({ url, title: '', text: '', error: err.message });
        }

        await this.humanizer.wait(page, 1500, 3000);
      }
    } catch (err) {
      result.success = false;
      result.message = err.message;
      onLog(`❌ ${err.message}`);

      if (loadConfig().monitoring?.screenshotOnError) {
        try {
          const errPath = path.join(__dirname, 'screenshots', `error-${Date.now()}.png`);
          if (!fs.existsSync(path.dirname(errPath))) {
            fs.mkdirSync(path.dirname(errPath), { recursive: true });
          }
          await page.screenshot({ path: errPath });
          onLog(`📸 Screenshot: ${path.basename(errPath)}`);
        } catch (screenshotErr) {
          DEBUG_MODE && console.warn('Erro screenshot:', screenshotErr.message);
        }
      }
    } finally {
      await browser.close();
    }

    return result;
  }
}

/* =========================================================================
 * EXPRESS + SOCKET.IO SERVER
 * ========================================================================= */

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

let botStatus = 'idle';
let lastRunSummary = null;
const bot = new ScraperBot();
const firestoreHelper = new FirestoreHelper();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// LOGGING
function broadcastLog(message) {
  const timestamp = new Date().toLocaleTimeString('pt-BR');
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  io.emit('log', line);

  // Salvar em arquivo
  const logFile = path.join(LOGS_PATH, `${new Date().toISOString().split('T')[0]}.log`);
  fs.appendFileSync(logFile, line + '\n');
}

function broadcastStatus(status) {
  botStatus = status;
  io.emit('status', status);
  io.emit('statusUpdate', { status, timestamp: new Date().toISOString() });
}

// ROUTES: CONFIG
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json({
    ...config,
    credentialsConfigured: Boolean(SITE_USER && SITE_PASS),
    telegramTokenConfigured: Boolean(TELEGRAM_BOT_TOKEN),
    proxyConfigured: Boolean(PROXY_URL),
    captchaEnabled: Boolean(CAPTCHA_API_KEY),
    firebaseEnabled: Boolean(db),
  });
});

app.post('/api/config', (req, res) => {
  const incoming = req.body || {};
  const current = loadConfig();
  const updated = {
    ...current,
    site: { ...current.site, ...(incoming.site || {}) },
    humanize: { ...current.humanize, ...(incoming.humanize || {}) },
    cloudflare: { ...current.cloudflare, ...(incoming.cloudflare || {}) },
    stealth: { ...current.stealth, ...(incoming.stealth || {}) },
    telegram: { ...current.telegram, ...(incoming.telegram || {}) },
    monitoring: { ...current.monitoring, ...(incoming.monitoring || {}) },
  };
  saveConfig(updated);
  res.json({ ok: true, config: updated });
});

// ROUTES: TASKS
app.get('/api/tasks', (req, res) => {
  const config = loadConfig();
  res.json(config.tasks || []);
});

app.post('/api/tasks', (req, res) => {
  const { keyword, action, param } = req.body || {};
  if (!keyword || !action) {
    return res.status(400).json({ error: 'keyword e action obrigatórios' });
  }

  const config = loadConfig();
  const nextOrder = config.tasks.length
    ? Math.max(...config.tasks.map((t) => t.order)) + 1
    : 1;

  const newTask = {
    id: randomUUID(),
    keyword,
    action,
    param: param || '',
    order: nextOrder,
    createdAt: new Date().toISOString(),
  };

  config.tasks.push(newTask);
  saveConfig(config);
  res.json({ ok: true, task: newTask });
});

app.put('/api/tasks/:id', (req, res) => {
  const { keyword, action, param } = req.body || {};
  const config = loadConfig();
  const task = config.tasks.find((t) => t.id === req.params.id);

  if (!task) {
    return res.status(404).json({ error: 'Tarefa não encontrada' });
  }

  if (keyword) task.keyword = keyword;
  if (action) task.action = action;
  if (param !== undefined) task.param = param;
  task.updatedAt = new Date().toISOString();

  saveConfig(config);
  res.json({ ok: true, task });
});

app.delete('/api/tasks/:id', (req, res) => {
  const config = loadConfig();
  config.tasks = config.tasks.filter((t) => t.id !== req.params.id);
  saveConfig(config);
  res.json({ ok: true });
});

app.post('/api/tasks/reorder', (req, res) => {
  const { orderedIds } = req.body || {};
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'orderedIds deve ser array' });
  }

  const config = loadConfig();
  const byId = Object.fromEntries(config.tasks.map((t) => [t.id, t]));
  config.tasks = orderedIds
    .map((id, idx) => (byId[id] ? { ...byId[id], order: idx + 1 } : null))
    .filter(Boolean);

  saveConfig(config);
  res.json({ ok: true, tasks: config.tasks });
});

// ROUTES: STATUS & EXECUTION
app.get('/api/status', (req, res) => {
  res.json({
    status: botStatus,
    lastRunSummary,
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/run', async (req, res) => {
  if (botStatus === 'running') {
    return res.status(409).json({ error: 'Bot já está em execução' });
  }

  const config = loadConfig();

  if (!SITE_USER || !SITE_PASS) {
    return res.status(400).json({
      error: 'Defina SITE_USER e SITE_PASS nas variáveis de ambiente',
    });
  }

  if (!config.site.loginUrl || !config.site.userSelector ||
      !config.site.passSelector || !config.site.submitSelector) {
    return res.status(400).json({ error: 'Configuração do site incompleta' });
  }

  res.json({ ok: true, message: 'Execução iniciada' });

  const runId = randomUUID();
  broadcastStatus('running');
  broadcastLog('🚀 Iniciando bot...');

  try {
    const scrapeResult = await bot.loginAndScrape(config, broadcastLog);

    if (!scrapeResult.success) {
      broadcastStatus('error');
      lastRunSummary = {
        at: new Date().toISOString(),
        success: false,
        message: scrapeResult.message,
        runId,
      };

      if (db) {
        await firestoreHelper.saveRun(lastRunSummary);
      }

      if (config.telegram.enabled) {
        await sendTelegramAlert(
          TELEGRAM_BOT_TOKEN,
          config.telegram.chatId,
          `❌ Bot falhou: ${scrapeResult.message}`
        );
      }
      return;
    }

    const allFindings = [];
    for (const pageResult of scrapeResult.pages) {
      if (pageResult.error) continue;

      const findings = await runTasksOnPage(pageResult, config.tasks || [], {
        log: broadcastLog,
        notifyTelegram: (msg) =>
          config.telegram.enabled
            ? sendTelegramAlert(TELEGRAM_BOT_TOKEN, config.telegram.chatId, msg)
            : Promise.resolve(),
        runId,
      }, db);

      allFindings.push({
        url: pageResult.url,
        title: pageResult.title,
        findings,
      });
    }

    lastRunSummary = {
      at: new Date().toISOString(),
      success: true,
      pagesVisited: scrapeResult.pages.length,
      totalFindings: allFindings.reduce((sum, p) => sum + p.findings.length, 0),
      details: allFindings,
      fingerprint: scrapeResult.fingerprint,
      runId,
    };

    if (db) {
      await firestoreHelper.saveRun(lastRunSummary);
    }

    broadcastStatus('success');
    broadcastLog('✅ Bot completado com sucesso');

    if (config.telegram.enabled) {
      await sendTelegramAlert(
        TELEGRAM_BOT_TOKEN,
        config.telegram.chatId,
        `✅ Análise concluída\n📊 Páginas: ${scrapeResult.pages.length}\n🔍 Achados: ${lastRunSummary.totalFindings}`
      );
    }
  } catch (err) {
    broadcastStatus('error');
    lastRunSummary = {
      at: new Date().toISOString(),
      success: false,
      message: err.message,
      runId,
    };

    if (db) {
      await firestoreHelper.saveRun(lastRunSummary);
    }

    broadcastLog(`❌ Erro: ${err.message}`);
  }
});

// ROUTES: MONITORING (Firestore)
app.get('/api/runs', async (req, res) => {
  if (!db) {
    return res.json([]);
  }
  const runs = await firestoreHelper.getRuns(100);
  res.json(runs);
});

app.get('/api/findings/:keyword', async (req, res) => {
  if (!db) {
    return res.json([]);
  }
  const findings = await firestoreHelper.getFindingsByKeyword(req.params.keyword);
  res.json(findings);
});

app.get('/api/fingerprints', (req, res) => {
  const gen = new FingerprintGenerator();
  res.json(gen.fingerprints);
});

app.get('/api/cookies', (req, res) => {
  const sm = new SessionManager();
  res.json({ count: sm.cookies.length });
});

app.delete('/api/cookies', (req, res) => {
  const sm = new SessionManager();
  sm.saveCookies([]);
  res.json({ ok: true, message: 'Cookies limpos' });
});

// WEBSOCKET
io.on('connection', (socket) => {
  broadcastLog(`👤 Cliente conectado: ${socket.id}`);
  socket.emit('status', botStatus);

  socket.on('disconnect', () => {
    broadcastLog(`👤 Cliente desconectado: ${socket.id}`);
  });
});

// SERVER START
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║  🤖 BOT SCRAPER ANTI-DETECÇÃO v3.0            ║
║  Rodando em http://localhost:${PORT}           ║
║  DEBUG: ${DEBUG_MODE ? 'ativado' : 'desativado'}                            ║
║  Firebase: ${db ? 'conectado' : 'desconectado'}                        ║
║  Captcha: ${CAPTCHA_API_KEY ? 'ativado' : 'desativado'}                        ║
╚════════════════════════════════════════════════╝
  `);

  broadcastLog('🟢 Servidor iniciado');
  broadcastLog(`Credenciais: ${SITE_USER ? '✅' : '❌'}`);
  broadcastLog(`Telegram: ${TELEGRAM_BOT_TOKEN ? '✅' : '❌'}`);
  broadcastLog(`Proxy: ${PROXY_URL ? '✅' : '❌'}`);
  broadcastLog(`Captcha (${CAPTCHA_SERVICE}): ${CAPTCHA_API_KEY ? '✅' : '❌'}`);
  broadcastLog(`Firebase Firestore: ${db ? '✅' : '❌'}`);
});

module.exports = { bot, ScraperBot, loadConfig, saveConfig, db };
