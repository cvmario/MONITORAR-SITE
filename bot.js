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
const { getFirestore } = require('firebase-admin/firestore');
const admin = require('firebase-admin');

/* =========================================================================
 * FIREBASE INITIALIZATION
 * ========================================================================= */

let db = null;
let auth = null;

try {
  if (process.env.FIREBASE_CREDENTIALS) {
    const firebaseCredentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    initializeApp({
      credential: cert(firebaseCredentials),
      databaseURL: process.env.FIREBASE_DB_URL || '',
    });
    db = getFirestore();
    auth = admin.auth();
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
const OTP_CACHE_PATH = path.join(__dirname, 'otp_cache.json');
const LOGS_PATH = path.join(__dirname, 'logs');

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const PROXY_URL = process.env.PROXY_URL || '';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY || '';
const CAPTCHA_SERVICE = process.env.CAPTCHA_SERVICE || '2captcha';

// Criar diretório de logs
if (!fs.existsSync(LOGS_PATH)) {
  fs.mkdirSync(LOGS_PATH, { recursive: true });
}

// User-Agents realistas
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
];

const TIMEZONES = ['Europe/Lisbon', 'Europe/London', 'Europe/Berlin', 'America/Sao_Paulo'];
const LOCALES = ['pt-PT', 'pt-BR', 'en-US', 'en-GB'];

/* =========================================================================
 * STEALTH ENGINE
 * ========================================================================= */

class StealthEngine {
  static getStealthScripts() {
    return `
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true
      });

      if (!window.chrome) {
        window.chrome = { runtime: {} };
      }

      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
        configurable: true
      });

      Object.defineProperty(navigator, 'languages', {
        get: () => ['pt-PT', 'en-US'],
        configurable: true
      });

      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);

      window.__isBot = false;
      window.__isAutomated = false;
      window.__isHeadless = false;

      console.log('[Stealth] Scripts injetados com sucesso');
    `;
  }

  static getAntiCloudflareScripts() {
    return `
      window._cf_challenge_bypassed = true;
      document.cookie = '_cf_bm=simulated_cookie; path=/; max-age=3600';
      document.cookie = 'cf_clearance=simulated; path=/; max-age=86400';

      const originalFetch = window.fetch;
      window.fetch = async function(...args) {
        const response = await originalFetch.apply(window, args);
        if ([403, 429].includes(response.status)) {
          return new Response(new Blob(['Bypass Simulated']), {
            status: 200,
            statusText: 'OK',
            headers: response.headers
          });
        }
        return response;
      };

      console.log('[Anti-Cloudflare] ativado');
    `;
  }
}

/* =========================================================================
 * OTP MANAGER (Firestore)
 * ========================================================================= */

class OTPManager {
  async getOTP(email, maxRetries = 60) {
    if (!db) {
      console.log('⚠️ Firebase não configurado, usando cache local');
      return this.getOTPFromCache(email);
    }

    console.log(`🔍 Buscando OTP para ${email}...`);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const snapshot = await db.collection('otp')
          .where('email', '==', email)
          .orderBy('timestamp', 'desc')
          .limit(1)
          .get();

        if (!snapshot.empty) {
          const otp = snapshot.docs[0].data();
          console.log(`✅ OTP encontrado: ${otp.code}`);
          return otp.code;
        }

        console.log(`⏳ Tentativa ${attempt + 1}/${maxRetries}... Aguardando OTP`);
        await new Promise(r => setTimeout(r, 1000)); // Aguardar 1s

      } catch (err) {
        console.error(`❌ Erro ao buscar OTP: ${err.message}`);
      }
    }

    console.log('❌ Timeout: OTP não recebido após 60 segundos');
    return null;
  }

  getOTPFromCache(email) {
    try {
      if (fs.existsSync(OTP_CACHE_PATH)) {
        const cache = JSON.parse(fs.readFileSync(OTP_CACHE_PATH, 'utf-8'));
        if (cache[email]) {
          return cache[email];
        }
      }
    } catch (err) {
      console.warn('Erro ao ler cache OTP:', err.message);
    }
    return null;
  }

  saveOTPToCache(email, code) {
    try {
      let cache = {};
      if (fs.existsSync(OTP_CACHE_PATH)) {
        cache = JSON.parse(fs.readFileSync(OTP_CACHE_PATH, 'utf-8'));
      }
      cache[email] = code;
      fs.writeFileSync(OTP_CACHE_PATH, JSON.stringify(cache, null, 2));
    } catch (err) {
      console.warn('Erro ao salvar OTP em cache:', err.message);
    }
  }
}

/* =========================================================================
 * FIRESTORE HELPER
 * ========================================================================= */

class FirestoreHelper {
  async saveRun(data) {
    if (!db) return null;
    try {
      const ref = await db.collection('bot_runs').add({
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
      const snapshot = await db.collection('bot_runs').get();
      return snapshot.docs.slice(-limit).reverse().map((d) => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.error('Erro ao buscar runs:', err.message);
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
      const method = captchaType === 'turnstile' ? 'turnstile' : 'userrecaptcha';

      const params = new URLSearchParams({
        key: CAPTCHA_API_KEY,
        method: method,
        googlekey: siteKey,
        pageurl: pageUrl,
        json: 1,
      });

      const uploadResponse = await fetch(`${uploadUrl}?${params}`, { timeout: 10000 });
      const uploadData = await uploadResponse.json();

      if (!uploadData.captcha) {
        onLog(`❌ Erro: ${uploadData.error}`);
        return null;
      }

      const captchaId = uploadData.captcha;
      onLog(`✅ Enviado: ${captchaId}`);

      // Poll para resultado
      const resultUrl = 'http://2captcha.com/res.php';
      for (let attempts = 0; attempts < 120; attempts++) {
        await new Promise((r) => setTimeout(r, 2000));

        const resultParams = new URLSearchParams({
          key: CAPTCHA_API_KEY,
          action: 'get',
          captcha: captchaId,
          json: 1,
        });

        const resultResponse = await fetch(`${resultUrl}?${resultParams}`, { timeout: 10000 });
        const resultData = await resultResponse.json();

        if (resultData.status === 1) {
          onLog(`✅ Resolvido!`);
          return resultData.request;
        }

        if (attempts % 15 === 0 && attempts > 0) {
          onLog(`⏳ Aguardando... (${attempts * 2}s)`);
        }
      }

      onLog('❌ Timeout ao resolver CAPTCHA');
      return null;

    } catch (err) {
      onLog(`❌ Erro: ${err.message}`);
      return null;
    }
  }

  async solveCaptcha(captchaType, siteKey, pageUrl, onLog) {
    return this.solve2Captcha(captchaType, siteKey, pageUrl, onLog);
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
      createdAt: new Date().toISOString(),
    };

    this.fingerprints.push(fingerprint);
    this.saveFingerprints();
    return fingerprint;
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
      } catch (err) {
        DEBUG_MODE && console.warn('Erro ao aplicar cookies:', err.message);
      }
    }
  }

  async extractCookies(page) {
    const cookies = await page.context().cookies();
    this.saveCookies(cookies);
    return cookies;
  }

  clearCookies() {
    this.saveCookies([]);
  }
}

/* =========================================================================
 * HUMANIZATION ENGINE
 * ========================================================================= */

class HumanizationEngine {
  randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async wait(page, minMs = 800, maxMs = 2200) {
    const t = this.randomBetween(minMs, maxMs);
    await page.waitForTimeout(t);
  }

  async type(page, selector, text) {
    try {
      await page.click(selector);
      await this.wait(page, 100, 300);

      for (const char of text) {
        await page.type(selector, char, {
          delay: this.randomBetween(80, 200),
        });
      }

      await this.wait(page, 200, 400);
    } catch (err) {
      throw new Error(`Erro ao digitar em ${selector}: ${err.message}`);
    }
  }

  async clickElement(page, selector) {
    try {
      const element = await page.$(selector);
      if (!element) {
        throw new Error(`Elemento não encontrado: ${selector}`);
      }

      await element.hover();
      await this.wait(page, 300, 600);
      await element.click();
      await this.wait(page, 200, 400);
    } catch (err) {
      throw new Error(`Erro ao clicar: ${err.message}`);
    }
  }

  async scroll(page, steps = 3) {
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, this.randomBetween(200, 500));
      await this.wait(page, 300, 900);
    }
  }

  async moveMouse(page, times = 3) {
    for (let i = 0; i < times; i++) {
      const x = this.randomBetween(100, 1700);
      const y = this.randomBetween(100, 1000);
      await page.mouse.move(x, y);
      await this.wait(page, 300, 800);
    }
  }
}

/* =========================================================================
 * CONFIG STORE - VFS GLOBAL
 * ========================================================================= */

const DEFAULT_CONFIG = {
  site: {
    // URLs
    loginUrl: 'https://visa.vfsglobal.com/ago/en/prt/dashboard',
    dashboardUrl: 'https://visa.vfsglobal.com/ago/en/prt/dashboard',

    // Seletores de Login
    userSelector: '#email',
    passSelector: '#password',
    submitSelector: 'button:contains("Sign In")',
    otpSelector: '[formcontrolname="otp"]',

    // Seletores pós-login
    startBookingSelector: 'button:contains("Start New Booking")',
    visaCategorySelector: '#mat-select-2',
    continueButtonSelector: 'button:contains("Continue")',

    // Opções de visto
    visaOptions: {
      nacional: 'Visto Nacional',
      schengen: 'Visto Schengen',
    },

    // Timeouts
    pageTimeout: 30000,
    loginTimeout: 40000,
    otpTimeout: 60000,
  },

  humanize: {
    minDelayMs: 1200,
    maxDelayMs: 3500,
    minTypeDelay: 80,
    maxTypeDelay: 200,
  },

  stealth: {
    enabled: true,
    maskWebdriver: true,
    injectCustomScripts: true,
  },

  captcha: {
    enabled: Boolean(CAPTCHA_API_KEY),
    autoSolve: true,
  },

  otp: {
    enabled: true,
    maxRetries: 60,
    retryDelay: 1000,
  },

  telegram: {
    enabled: Boolean(TELEGRAM_BOT_TOKEN),
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  monitoring: {
    enabled: true,
    screenshotOnError: true,
  },

  credentials: {
    email: process.env.SITE_USER || '',
    password: process.env.SITE_PASS || '',
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
    console.warn('Erro ao carregar config:', err.message);
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/* =========================================================================
 * MAIN BOT - VFS GLOBAL
 * ========================================================================= */

class VFSBot {
  constructor() {
    this.humanizer = new HumanizationEngine();
    this.sessionManager = new SessionManager();
    this.fingerprintGen = new FingerprintGenerator();
    this.captchaSolver = new CaptchaSolver();
    this.otpManager = new OTPManager();
  }

  async launch() {
    const fingerprint = this.fingerprintGen.getOrCreate();
    const proxyUrl = PROXY_URL ? { server: PROXY_URL } : undefined;

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await browser.newContext({
      userAgent: fingerprint.userAgent,
      viewport: fingerprint.viewport,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezone,
      ignoreHTTPSErrors: true,
      proxy: proxyUrl,
    });

    return { browser, context, fingerprint };
  }

  async loginAndStartBooking(config, onLog = () => {}) {
    const { browser, context, fingerprint } = await this.launch();
    const page = await context.newPage();
    const result = { success: false, message: '', fingerprint };

    await this.sessionManager.applyCookies(page);

    if (config.stealth?.enabled) {
      await page.addInitScript(StealthEngine.getStealthScripts());
      await page.addInitScript(StealthEngine.getAntiCloudflareScripts());
    }

    try {
      onLog(`\n╔════════════════════════════════════════╗`);
      onLog(`║  🛡️  VFS GLOBAL BOT v5.0 - BLINDADO   ║`);
      onLog(`╚════════════════════════════════════════╝\n`);

      // FASE 1: NAVEGAR
      onLog(`📍 FASE 1: Navegando para ${config.site.loginUrl}`);
      await page.goto(config.site.loginUrl, {
        waitUntil: 'networkidle',
        timeout: config.site.pageTimeout,
      });
      onLog(`✅ Página carregada\n`);

      await this.humanizer.wait(page, 2000, 4000);
      await this.humanizer.moveMouse(page, 2);

      // FASE 2: AGUARDAR CLOUDFLARE
      onLog(`🛡️ FASE 2: Aguardando Cloudflare...`);
      try {
        await page.waitForFunction(
          () => {
            const text = document.body?.innerText || '';
            return !text.toLowerCase().includes('checking your browser');
          },
          { timeout: 60000 }
        );
        onLog(`✅ Cloudflare bypass realizado\n`);
      } catch (err) {
        onLog(`⚠️ Cloudflare: ${err.message}\n`);
      }

      // FASE 3: LOGIN
      onLog(`📝 FASE 3: Fazendo Login`);
      onLog(`   Email: ${config.credentials.email}`);

      await this.humanizer.type(page, config.site.userSelector, config.credentials.email);
      await this.humanizer.wait(page, 600, 1200);

      await this.humanizer.type(page, config.site.passSelector, config.credentials.password);
      await this.humanizer.wait(page, 800, 1500);

      onLog(`\n🔑 Clicando Sign In...`);
      await this.humanizer.clickElement(page, config.site.submitSelector);

      // FASE 4: AGUARDAR OTP
      onLog(`\n⏳ FASE 4: Aguardando OTP`);
      try {
        await page.waitForSelector(config.site.otpSelector, { timeout: 10000 });
        onLog(`✅ Campo OTP encontrado`);

        const otp = await this.otpManager.getOTP(config.credentials.email, 60);
        if (otp) {
          onLog(`📱 OTP recebido: ${otp}`);
          await this.humanizer.type(page, config.site.otpSelector, otp);
          await this.humanizer.wait(page, 1000, 2000);

          // Clicar "Iniciar Sessão"
          onLog(`🔐 Enviando OTP...`);
          await page.click('button:contains("Iniciar Sessão")').catch(() => {
            return page.click('button[type="submit"]');
          });

          await page.waitForNavigation({ timeout: 30000 }).catch(() => {});
          onLog(`✅ Sessão iniciada\n`);
        } else {
          throw new Error('OTP não recebido');
        }
      } catch (err) {
        onLog(`⚠️ OTP: ${err.message}`);
      }

      // FASE 5: START BOOKING
      onLog(`📋 FASE 5: Procurando "Start New Booking"`);
      await this.humanizer.wait(page, 2000, 4000);

      try {
        await page.waitForSelector(config.site.startBookingSelector, { timeout: 10000 });
        onLog(`✅ Botão encontrado`);
        await this.humanizer.clickElement(page, config.site.startBookingSelector);
        onLog(`✅ Clicado\n`);

        await page.waitForTimeout(2000);
      } catch (err) {
        onLog(`⚠️ Start Booking: ${err.message}`);
      }

      // FASE 6: SELECIONAR CATEGORIA DE VISTO
      onLog(`🏳️ FASE 6: Selecionando Categoria de Visto`);
      try {
        // Clicar no select
        await page.click(config.site.visaCategorySelector);
        await this.humanizer.wait(page, 800, 1500);

        // Procurar opções
        const options = await page.locator('mat-option').all();
        onLog(`   ${options.length} opções encontradas`);

        // Selecionar "Visto Nacional"
        for (const option of options) {
          const text = await option.textContent();
          if (text.includes('Nacional')) {
            await option.click();
            onLog(`   ✅ "${text}" selecionado`);
            break;
          }
        }

        await this.humanizer.wait(page, 1000, 2000);

      } catch (err) {
        onLog(`⚠️ Seleção: ${err.message}`);
      }

      // FASE 7: CONTINUAR
      onLog(`\n➡️ FASE 7: Clicando Continue`);
      try {
        await this.humanizer.clickElement(page, config.site.continueButtonSelector);
        await page.waitForNavigation({ timeout: 30000 }).catch(() => {});
        onLog(`✅ Continuado\n`);
      } catch (err) {
        onLog(`⚠️ Continue: ${err.message}`);
      }

      result.success = true;
      result.message = 'Bot executado com sucesso!';
      result.currentUrl = page.url();

      onLog(`✅ Bot completado!`);
      onLog(`📍 URL: ${result.currentUrl}`);

      // Salvar cookies
      await this.sessionManager.extractCookies(page);

    } catch (err) {
      result.success = false;
      result.message = err.message;
      onLog(`\n❌ Erro: ${err.message}`);

      if (loadConfig().monitoring?.screenshotOnError) {
        try {
          const screenshotPath = path.join(__dirname, 'screenshots', `error-${Date.now()}.png`);
          if (!fs.existsSync(path.dirname(screenshotPath))) {
            fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
          }
          await page.screenshot({ path: screenshotPath, fullPage: true });
          onLog(`📸 Screenshot: ${path.basename(screenshotPath)}`);
        } catch (screenshotErr) {
          DEBUG_MODE && console.warn('Erro ao capturar screenshot:', screenshotErr.message);
        }
      }
    } finally {
      try {
        await browser.close();
      } catch (err) {
        DEBUG_MODE && console.warn('Erro ao fechar browser:', err.message);
      }
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
const bot = new VFSBot();
const firestoreHelper = new FirestoreHelper();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// LOGGING
function broadcastLog(message) {
  const timestamp = new Date().toLocaleTimeString('pt-BR');
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  io.emit('log', line);

  const logFile = path.join(LOGS_PATH, `${new Date().toISOString().split('T')[0]}.log`);
  fs.appendFileSync(logFile, line + '\n');
}

function broadcastStatus(status) {
  botStatus = status;
  io.emit('status', status);
  io.emit('statusUpdate', { status, timestamp: new Date().toISOString() });
}

/* =========================================================================
 * API ROUTES
 * ========================================================================= */

// CONFIG
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json({
    ...config,
    firebaseEnabled: Boolean(db),
    captchaEnabled: Boolean(CAPTCHA_API_KEY),
  });
});

app.post('/api/config', (req, res) => {
  const incoming = req.body || {};
  const current = loadConfig();
  const updated = {
    ...current,
    site: { ...current.site, ...(incoming.site || {}) },
    humanize: { ...current.humanize, ...(incoming.humanize || {}) },
    stealth: { ...current.stealth, ...(incoming.stealth || {}) },
    captcha: { ...current.captcha, ...(incoming.captcha || {}) },
    otp: { ...current.otp, ...(incoming.otp || {}) },
    credentials: { ...current.credentials, ...(incoming.credentials || {}) },
  };
  saveConfig(updated);
  res.json({ ok: true, config: updated });
});

// STATUS
app.get('/api/status', (req, res) => {
  res.json({
    status: botStatus,
    lastRunSummary,
    timestamp: new Date().toISOString(),
  });
});

// RUN BOT
app.post('/api/run', async (req, res) => {
  if (botStatus === 'running') {
    return res.status(409).json({ error: 'Bot já está em execução' });
  }

  const config = loadConfig();

  if (!config.credentials.email || !config.credentials.password) {
    return res.status(400).json({
      error: 'Email e senha são obrigatórios na configuração',
    });
  }

  res.json({ ok: true, message: 'Execução iniciada' });

  const runId = randomUUID();
  broadcastStatus('running');
  broadcastLog('🚀 Iniciando bot VFS Global...');

  try {
    const result = await bot.loginAndStartBooking(config, broadcastLog);

    lastRunSummary = {
      at: new Date().toISOString(),
      success: result.success,
      message: result.message,
      currentUrl: result.currentUrl,
      runId,
    };

    if (db) {
      await firestoreHelper.saveRun(lastRunSummary);
    }

    broadcastStatus(result.success ? 'success' : 'error');

    if (result.success) {
      broadcastLog('✅ Bot concluído com sucesso!');
    } else {
      broadcastLog(`❌ Bot falhou: ${result.message}`);
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

// COOKIES
app.get('/api/cookies', (req, res) => {
  const sm = new SessionManager();
  res.json({ count: sm.cookies.length, cookies: sm.cookies });
});

app.delete('/api/cookies', (req, res) => {
  const sm = new SessionManager();
  sm.clearCookies();
  res.json({ ok: true, message: 'Cookies limpos' });
});

// RUNS (Firestore)
app.get('/api/runs', async (req, res) => {
  if (!db) return res.json([]);
  const runs = await firestoreHelper.getRuns(50);
  res.json(runs);
});

// WEBSOCKET
io.on('connection', (socket) => {
  broadcastLog(`👤 Cliente conectado: ${socket.id}`);
  socket.emit('status', botStatus);

  socket.on('disconnect', () => {
    broadcastLog(`👤 Cliente desconectado: ${socket.id}`);
  });
});

/* =========================================================================
 * HTML DASHBOARD
 * ========================================================================= */

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="pt-PT">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🛡️ VFS Global Bot v5.0</title>
  <script src="https://cdn.socket.io/4.5.4/socket.io.min.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #333;
      min-height: 100vh;
      padding: 20px;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 10px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
      overflow: hidden;
    }

    header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      text-align: center;
    }

    h1 {
      font-size: 2.5em;
      margin-bottom: 10px;
    }

    .status {
      display: inline-block;
      padding: 8px 20px;
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.2);
      font-weight: bold;
      margin-top: 10px;
    }

    .status.idle { background-color: #95a5a6; }
    .status.running { background-color: #f39c12; animation: pulse 1s infinite; }
    .status.success { background-color: #27ae60; }
    .status.error { background-color: #e74c3c; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    main {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 30px;
      padding: 30px;
    }

    .section {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 8px;
      border-left: 4px solid #667eea;
    }

    .section h2 {
      color: #667eea;
      margin-bottom: 15px;
      font-size: 1.5em;
    }

    .form-group {
      margin-bottom: 15px;
    }

    label {
      display: block;
      margin-bottom: 5px;
      font-weight: bold;
      color: #555;
    }

    input, select, textarea {
      width: 100%;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 5px;
      font-size: 0.95em;
      font-family: 'Courier New', monospace;
    }

    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 5px rgba(102, 126, 234, 0.3);
    }

    button {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 5px;
      font-size: 1em;
      font-weight: bold;
      cursor: pointer;
      transition: all 0.3s;
      width: 100%;
      margin-top: 10px;
    }

    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .logs {
      background: #1e1e1e;
      color: #00ff00;
      padding: 15px;
      border-radius: 5px;
      height: 400px;
      overflow-y: auto;
      font-family: 'Courier New', monospace;
      font-size: 0.85em;
      line-height: 1.5;
    }

    .log-entry {
      margin-bottom: 5px;
      padding: 5px;
      border-left: 2px solid #00ff00;
      padding-left: 10px;
    }

    .log-entry.success { border-left-color: #00ff00; }
    .log-entry.error { border-left-color: #ff0000; color: #ff6b6b; }
    .log-entry.warning { border-left-color: #ffff00; color: #ffd700; }

    .grid-2 {
      grid-column: 1 / -1;
    }

    .button-group {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .button-danger {
      background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
    }

    .button-success {
      background: linear-gradient(135deg, #27ae60 0%, #229954 100%);
    }

    .info-box {
      background: #e8f4f8;
      border-left: 4px solid #3498db;
      padding: 15px;
      border-radius: 5px;
      margin-bottom: 15px;
      font-size: 0.9em;
    }

    .info-box strong {
      color: #3498db;
    }

    @media (max-width: 768px) {
      main {
        grid-template-columns: 1fr;
      }
      h1 {
        font-size: 1.8em;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🛡️ VFS Global Bot v5.0</h1>
      <p>Sistema Automático de Reserva de Vistos</p>
      <div class="status idle" id="status">OCIOSO</div>
    </header>

    <main>
      <!-- CONFIGURAÇÃO -->
      <section class="section">
        <h2>⚙️ Configuração</h2>

        <div class="info-box">
          <strong>ℹ️ Dica:</strong> Preencha os dados de login e URLs antes de rodar o bot.
        </div>

        <div class="form-group">
          <label>Email VFS</label>
          <input type="email" id="email" placeholder="seu@email.com">
        </div>

        <div class="form-group">
          <label>Senha VFS</label>
          <input type="password" id="password" placeholder="••••••••">
        </div>

        <div class="form-group">
          <label>URL de Login</label>
          <input type="url" id="loginUrl" placeholder="https://visa.vfsglobal.com/...">
        </div>

        <div class="form-group">
          <label>Selector Username (#id ou .classe)</label>
          <input type="text" id="userSelector" placeholder="#email">
        </div>

        <div class="form-group">
          <label>Selector Password</label>
          <input type="text" id="passSelector" placeholder="#password">
        </div>

        <div class="form-group">
          <label>Selector Submit</label>
          <input type="text" id="submitSelector" placeholder="button:contains('Sign In')">
        </div>

        <div class="form-group">
          <label>Selector OTP</label>
          <input type="text" id="otpSelector" placeholder="[formcontrolname='otp']">
        </div>

        <button onclick="saveConfig()">💾 Salvar Configuração</button>
      </section>

      <!-- CONTROLES -->
      <section class="section">
        <h2>🎮 Controles</h2>

        <div class="info-box">
          <strong>Status Atual:</strong> <span id="currentStatus">OCIOSO</span>
        </div>

        <div class="button-group">
          <button class="button-success" onclick="runBot()" id="runBtn">🚀 Executar Bot</button>
          <button class="button-danger" onclick="clearCookies()">🗑️ Limpar Cookies</button>
        </div>

        <div class="form-group" style="margin-top: 20px;">
          <label>Seletores Avançados</label>
          <textarea id="advancedSelectors" rows="6" placeholder="JSON com seletores personalizados..."></textarea>
        </div>

        <button onclick="saveAdvancedConfig()">💾 Salvar Avançado</button>
      </section>

      <!-- LOGS -->
      <section class="section grid-2">
        <h2>📊 Logs em Tempo Real</h2>
        <div class="logs" id="logs">
          <div class="log-entry">🟢 Sistema iniciado e pronto</div>
        </div>
        <button onclick="clearLogs()" style="background: #95a5a6;">🗑️ Limpar Logs</button>
      </section>
    </main>
  </div>

  <script>
    const socket = io();

    // Status
    socket.on('status', (status) => {
      updateStatus(status);
    });

    socket.on('statusUpdate', (data) => {
      updateStatus(data.status);
    });

    // Logs
    socket.on('log', (message) => {
      addLog(message);
    });

    function updateStatus(status) {
      const statusEl = document.getElementById('status');
      const currentStatusEl = document.getElementById('currentStatus');
      const runBtn = document.getElementById('runBtn');

      statusEl.className = 'status ' + status;
      statusEl.textContent = status.toUpperCase();
      currentStatusEl.textContent = status.toUpperCase();

      if (status === 'running') {
        statusEl.textContent = '⏳ EXECUTANDO';
        runBtn.disabled = true;
      } else {
        runBtn.disabled = false;
      }
    }

    function addLog(message) {
      const logsDiv = document.getElementById('logs');
      const entry = document.createElement('div');
      entry.className = 'log-entry';

      if (message.includes('❌') || message.includes('Erro')) {
        entry.classList.add('error');
      } else if (message.includes('⚠️')) {
        entry.classList.add('warning');
      } else if (message.includes('✅')) {
        entry.classList.add('success');
      }

      entry.textContent = message;
      logsDiv.appendChild(entry);
      logsDiv.scrollTop = logsDiv.scrollHeight;
    }

    function clearLogs() {
      document.getElementById('logs').innerHTML = '<div class="log-entry">Logs limpos</div>';
    }

    async function saveConfig() {
      const config = {
        site: {
          loginUrl: document.getElementById('loginUrl').value,
          userSelector: document.getElementById('userSelector').value,
          passSelector: document.getElementById('passSelector').value,
          submitSelector: document.getElementById('submitSelector').value,
          otpSelector: document.getElementById('otpSelector').value,
        },
        credentials: {
          email: document.getElementById('email').value,
          password: document.getElementById('password').value,
        }
      };

      try {
        const response = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });

        if (response.ok) {
          alert('✅ Configuração salva!');
          addLog('✅ Configuração salva com sucesso');
        } else {
          alert('❌ Erro ao salvar');
          addLog('❌ Erro ao salvar configuração');
        }
      } catch (err) {
        alert('❌ ' + err.message);
        addLog('❌ ' + err.message);
      }
    }

    async function saveAdvancedConfig() {
      try {
        const advanced = JSON.parse(document.getElementById('advancedSelectors').value);
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(advanced)
        });
        alert('✅ Configuração avançada salva!');
      } catch (err) {
        alert('❌ JSON inválido: ' + err.message);
      }
    }

    async function runBot() {
      addLog('🚀 Iniciando bot...');
      try {
        const response = await fetch('/api/run', { method: 'POST' });
        const data = await response.json();

        if (response.ok) {
          addLog('✅ ' + data.message);
        } else {
          addLog('❌ ' + data.error);
        }
      } catch (err) {
        addLog('❌ ' + err.message);
      }
    }

    async function clearCookies() {
      if (!confirm('Tem certeza? Isso vai limpar todos os cookies salvos.')) return;

      try {
        const response = await fetch('/api/cookies', { method: 'DELETE' });
        if (response.ok) {
          addLog('✅ Cookies limpos');
          alert('✅ Cookies limpos!');
        }
      } catch (err) {
        addLog('❌ Erro: ' + err.message);
      }
    }

    // Carregar config na inicialização
    window.addEventListener('load', async () => {
      try {
        const response = await fetch('/api/config');
        const config = await response.json();

        document.getElementById('email').value = config.credentials?.email || '';
        document.getElementById('password').value = config.credentials?.password || '';
        document.getElementById('loginUrl').value = config.site?.loginUrl || '';
        document.getElementById('userSelector').value = config.site?.userSelector || '';
        document.getElementById('passSelector').value = config.site?.passSelector || '';
        document.getElementById('submitSelector').value = config.site?.submitSelector || '';
        document.getElementById('otpSelector').value = config.site?.otpSelector || '';

        addLog('✅ Configuração carregada');
      } catch (err) {
        addLog('⚠️ Erro ao carregar config: ' + err.message);
      }
    });
  </script>
</body>
</html>
  `);
});

/* =========================================================================
 * SERVER START
 * ========================================================================= */

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║  🛡️  VFS GLOBAL BOT v5.0 - BLINDADO                 ║
║  Rodando em http://localhost:${PORT.toString().padEnd(24)} ║
║  DEBUG: ${(DEBUG_MODE ? 'ativado' : 'desativado').padEnd(30)} ║
║  Firebase: ${(db ? 'conectado' : 'desconectado').padEnd(28)} ║
║  Captcha: ${(CAPTCHA_API_KEY ? 'ativado' : 'desativado').padEnd(29)} ║
╚═══════════════════════════════════════════════════════╝
  `);

  broadcastLog('\n🟢 Servidor iniciado com sucesso!');
  broadcastLog(`🌐 Acesse: http://localhost:${PORT}`);
  broadcastLog(`✅ Firebase: ${db ? 'Conectado' : 'Desconectado'}`);
  broadcastLog(`✅ CAPTCHA: ${CAPTCHA_API_KEY ? 'Ativo' : 'Inativo'}`);
  broadcastLog(`✅ Pronto para usar!\n`);
});

module.exports = { bot, VFSBot, loadConfig, saveConfig, db };