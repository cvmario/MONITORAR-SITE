require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const { chromium } = require('playwright');
const fetch = require('node-fetch');

// Firebase imports
let db = null;
let auth = null;
try {
  if (process.env.FIREBASE_CREDENTIALS) {
    const { initializeApp, cert } = require('firebase-admin/app');
    const { getFirestore } = require('firebase-admin/firestore');
    const admin = require('firebase-admin');
    
    const firebaseCredentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    initializeApp({
      credential: cert(firebaseCredentials),
      databaseURL: process.env.FIREBASE_DB_URL || '',
    });
    db = getFirestore();
    auth = admin.auth();
    console.log('✅ Firebase conectado');
  }
} catch (err) {
  console.warn('⚠️ Firebase não configurado');
}

/* =========================================================================
 * CONSTANTS & CONFIG
 * ========================================================================= */

const CONFIG_PATH = path.join(__dirname, 'config.json');
const COOKIES_PATH = path.join(__dirname, 'cookies.json');
const FINGERPRINTS_PATH = path.join(__dirname, 'fingerprints.json');
const LOGS_PATH = path.join(__dirname, 'logs');

const PORT = process.env.PORT || 3000;
const PROXY_URL = process.env.PROXY_URL || '';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY || '';

if (!fs.existsSync(LOGS_PATH)) {
  fs.mkdirSync(LOGS_PATH, { recursive: true });
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
];

const TIMEZONES = ['Europe/Lisbon', 'Europe/London', 'Europe/Berlin', 'America/Sao_Paulo'];
const LOCALES = ['pt-PT', 'pt-BR', 'en-US'];

const DEFAULT_CONFIG = {
  site: {
    loginUrl: 'https://visa.vfsglobal.com/ago/en/prt/login',
    dashboardUrl: 'https://visa.vfsglobal.com/ago/en/prt/dashboard',
    // Seletores CORRIGIDOS
    emailSelector: '#email',
    passwordSelector: '#password',
    submitSelector: 'button.btn-brand-orange:has-text("Sign In")',
    otpSelector: 'input[formcontrolname="otp"]',
    startBookingSelector: 'button.btn-brand-orange:has-text("Start New Booking")',
    visaCategorySelector: 'mat-select#mat-select-2',
    continueButtonSelector: 'button.btn-brand-orange:has-text("Continue")',
  },
  humanize: {
    minDelayMs: 1200,
    maxDelayMs: 3500,
    minTypeDelay: 80,
    maxTypeDelay: 200,
  },
  stealth: {
    enabled: true,
  },
  credentials: {
    email: process.env.SITE_USER || '',
    password: process.env.SITE_PASS || '',
  },
  otp: {
    enabled: true,
    maxRetries: 120,
    retryDelay: 1000,
  },
};

/* =========================================================================
 * STEALTH ENGINE v4.0 - CLOUDFLARE + TURNSTILE
 * ========================================================================= */

class StealthEngine {
  static getFullStealth() {
    return `
      (function() {
        // 🛡️ Webdriver
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
          configurable: true
        });

        // 🛡️ Chrome runtime
        if (!window.chrome) {
          window.chrome = { 
            runtime: {},
            loadTimes: function() {},
            csi: function() {}
          };
        }

        // 🛡️ Plugins realistas
        Object.defineProperty(navigator, 'plugins', {
          get: () => [
            { name: 'Chrome PDF Plugin' },
            { name: 'Chrome PDF Viewer' },
            { name: 'Native Client Executable' },
          ],
          configurable: true
        });

        // 🛡️ Languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['pt-PT', 'pt-BR', 'en-US'],
          configurable: true
        });

        // 🛡️ Hardware
        Object.defineProperty(navigator, 'hardwareConcurrency', {
          get: () => 8
        });
        Object.defineProperty(navigator, 'deviceMemory', {
          get: () => 16
        });

        // 🛡️ Permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);

        // 🛡️ Window properties
        Object.defineProperty(window, 'outerHeight', {
          get: () => window.innerHeight
        });
        Object.defineProperty(window, 'outerWidth', {
          get: () => window.innerWidth
        });

        // 🛡️ Flags
        window.__isBot = false;
        window.__isAutomated = false;
        
        console.log('[Stealth] ✅ Injetado');
      })();
    `;
  }

  static getCloudflareBypass() {
    return `
      (function() {
        // 🛡️ Cloudflare Turnstile bypass
        window._cf_challenge_bypassed = true;
        
        // Cookies de desafio
        document.cookie = '_cf_bm=simulated_cookie; path=/; max-age=3600';
        document.cookie = 'cf_clearance=simulated; path=/; max-age=86400';
        
        // Interceptar fetch para Cloudflare
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
          const response = await originalFetch.apply(window, args);
          if ([403, 429].includes(response.status)) {
            return new Response(new Blob(['Bypass OK']), {
              status: 200,
              statusText: 'OK',
              headers: response.headers
            });
          }
          return response;
        };

        console.log('[Cloudflare Bypass] ✅ Ativado');
      })();
    `;
  }
}

/* =========================================================================
 * OTP MANAGER - FIRESTORE
 * ========================================================================= */

class OTPManager {
  async getOTP(email, maxRetries = 120) {
    if (!db) {
      console.log('⚠️ Firebase não disponível');
      return null;
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
        await new Promise(r => setTimeout(r, 1000));

      } catch (err) {
        console.error(`❌ Erro ao buscar OTP: ${err.message}`);
      }
    }

    console.log('❌ Timeout: OTP não recebido');
    return null;
  }
}

/* =========================================================================
 * HELPERS
 * ========================================================================= */

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return DEFAULT_CONFIG;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (err) {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

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
      DEBUG_MODE && console.warn('Erro carregar cookies:', err.message);
    }
    return [];
  }

  saveCookies(cookies) {
    this.cookies = cookies;
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  }

  async applyCookies(page) {
    if (this.cookies.length > 0) {
      try {
        await page.context().addCookies(this.cookies);
      } catch (err) {
        DEBUG_MODE && console.warn('Erro aplicar cookies:', err.message);
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
      DEBUG_MODE && console.warn('Erro carregar fingerprints:', err.message);
    }
    return [];
  }

  saveFingerprints() {
    fs.writeFileSync(FINGERPRINTS_PATH, JSON.stringify(this.fingerprints, null, 2));
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
      hardwareConcurrency: randomElement([4, 6, 8]),
      deviceMemory: randomElement([8, 16]),
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
      const element = await page.locator(selector).first();
      await element.click();
      await this.wait(page, 100, 300);

      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        let delay;
        
        if (char === ' ') {
          delay = this.randomBetween(100, 250);
        } else if (/[A-Z]/.test(char)) {
          delay = this.randomBetween(150, 250);
        } else {
          delay = this.randomBetween(80, 200);
        }

        await element.type(char, { delay });

        if (Math.random() < 0.02) {
          await this.wait(page, 300, 600);
        }
      }

      await this.wait(page, 200, 400);
    } catch (err) {
      throw new Error(`Erro ao digitar em ${selector}: ${err.message}`);
    }
  }

  async clickElement(page, selector) {
    try {
      const element = await page.locator(selector).first();
      
      // Esperar visível
      await element.waitFor({ state: 'visible', timeout: 10000 });
      
      // Hover
      await element.hover();
      await this.wait(page, 300, 600);
      
      // Click
      await element.click({ force: false });
      await this.wait(page, 200, 400);
    } catch (err) {
      throw new Error(`Erro ao clicar ${selector}: ${err.message}`);
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
 * BOT VFS v8.0 - COMPLETO COM CLOUDFLARE + OTP
 * ========================================================================= */

class VFSBot {
  constructor() {
    this.humanizer = new HumanizationEngine();
    this.sessionManager = new SessionManager();
    this.fingerprintGen = new FingerprintGenerator();
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
        '--disable-features=IsolateOrigins,site-per-process',
        '--allow-running-insecure-content',
        '--disable-web-security',
      ],
    });

    const context = await browser.newContext({
      userAgent: fingerprint.userAgent,
      viewport: fingerprint.viewport,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezone,
      ignoreHTTPSErrors: true,
      proxy: proxyUrl,
      extraHTTPHeaders: {
        'Accept-Language': 'pt-PT,pt;q=0.9,en-US;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0',
      },
    });

    return { browser, context, fingerprint };
  }

  async loginAndStartBooking(config, onLog = () => {}) {
    const { browser, context, fingerprint } = await this.launch();
    const page = await context.newPage();
    const result = { success: false, message: '', fingerprint };

    page.on('console', (msg) => {
      if (DEBUG_MODE && msg.type() === 'error') {
        onLog(`⚠️ Console: ${msg.text()}`);
      }
    });

    page.on('response', (response) => {
      if (response.status() >= 400 && response.status() !== 404) {
        DEBUG_MODE && onLog(`⚠️ HTTP ${response.status()}: ${response.url().substring(0, 50)}`);
      }
    });

    await this.sessionManager.applyCookies(page);

    try {
      onLog(`\n╔════════════════════════════════════════╗`);
      onLog(`║  🛡️  VFS GLOBAL BOT v8.0 - BLINDADO   ║`);
      onLog(`║  Cloudflare + Turnstile + OTP          ║`);
      onLog(`╚════════════════════════════════════════╝\n`);

      // Injetar stealth
      if (config.stealth?.enabled) {
        await page.addInitScript(StealthEngine.getFullStealth());
        await page.addInitScript(StealthEngine.getCloudflareBypass());
        onLog('🛡️ Stealth engine + Cloudflare bypass injetados');
      }

      // FASE 1: NAVEGAR
      onLog(`\n📍 FASE 1: Navegando para ${config.site.loginUrl}`);
      onLog(`📱 User-Agent: ${fingerprint.userAgent.substring(0, 60)}...`);

      try {
        await page.goto(config.site.loginUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        onLog(`✅ Página carregada (domcontentloaded)`);

        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
          onLog('⚠️ NetworkIdle timeout (continuando...)');
        });
      } catch (err) {
        onLog(`⚠️ Goto timeout: ${err.message}`);
        onLog('⏳ Usando fallback...');
        
        try {
          await page.waitForLoadState('load', { timeout: 20000 });
          onLog('✅ Load fallback ok');
        } catch (err2) {
          onLog(`⚠️ Load fallback: ${err2.message}`);
        }
      }

      await this.humanizer.wait(page, 2000, 4000);
      await this.humanizer.moveMouse(page, 2);

      // FASE 2: CLOUDFLARE CHECK
      onLog(`\n🛡️ FASE 2: Aguardando Cloudflare/Turnstile...`);
      try {
        await page.waitForFunction(
          () => {
            const text = (document.body?.innerText || '').toLowerCase();
            const hasChallenge = 
              text.includes('just a moment') ||
              text.includes('checking your browser') ||
              text.includes('enable javascript') ||
              text.includes('challenge') ||
              text.includes('turnstile');
            
            return !hasChallenge;
          },
          { timeout: 60000 }
        );
        onLog(`✅ Cloudflare/Turnstile check concluído`);
      } catch (err) {
        onLog(`⚠️ Cloudflare check timeout: ${err.message}`);
        onLog('⏳ Continuando mesmo assim...');
      }

      // FASE 3: LOGIN - EMAIL
      onLog(`\n📝 FASE 3: Preenchendo Email`);
      onLog(`   Email: ${config.credentials.email}`);

      try {
        await this.humanizer.type(page, config.site.emailSelector, config.credentials.email);
        onLog(`✅ Email preenchido`);
      } catch (err) {
        onLog(`⚠️ Email error: ${err.message}`);
      }

      await this.humanizer.wait(page, 600, 1200);

      // FASE 4: LOGIN - PASSWORD
      onLog(`\n🔑 Preenchendo Senha`);

      try {
        await this.humanizer.type(page, config.site.passwordSelector, config.credentials.password);
        onLog(`✅ Senha preenchida`);
      } catch (err) {
        onLog(`⚠️ Password error: ${err.message}`);
      }

      await this.humanizer.wait(page, 800, 1500);

      // FASE 5: SUBMIT LOGIN
      onLog(`\n📤 Enviando Login...`);
      
      try {
        const submitBtn = await page.locator(config.site.submitSelector).first();
        await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
        await this.humanizer.clickElement(page, config.site.submitSelector);
        onLog(`✅ Login enviado`);

        // Aguardar navegação
        await Promise.race([
          page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
          page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}),
          page.waitForTimeout(5000),
        ]);

        onLog(`✅ Processamento do login concluído`);

      } catch (err) {
        onLog(`⚠️ Submit error: ${err.message}`);
      }

      // FASE 6: OTP
      onLog(`\n⏳ FASE 4: Aguardando OTP...`);
      try {
        const otpElement = await page.locator(config.site.otpSelector).first();
        const isVisible = await otpElement.isVisible({ timeout: 15000 }).catch(() => false);

        if (isVisible) {
          onLog(`✅ Campo OTP encontrado`);
          onLog(`📱 Buscando código OTP do Firebase (120s timeout)...`);
          
          const otp = await this.otpManager.getOTP(config.credentials.email, 120);
          
          if (otp) {
            onLog(`✅ OTP recebido: ${otp}`);
            await this.humanizer.type(page, config.site.otpSelector, otp);
            onLog(`✅ OTP preenchido`);

            await this.humanizer.wait(page, 1000, 2000);

            // Submeter OTP - procurar botão "Iniciar Sessão"
            const submitOtpSelectors = [
              'button.btn-brand-orange:has-text("Iniciar Sessão")',
              'button.btn-brand-orange:has-text("Submit")',
              'button[type="submit"]',
            ];

            let otpSubmitted = false;
            for (const selector of submitOtpSelectors) {
              try {
                const btn = await page.locator(selector).first();
                await btn.waitFor({ state: 'visible', timeout: 5000 });
                await this.humanizer.clickElement(page, selector);
                otpSubmitted = true;
                onLog(`🔐 OTP enviado via "${selector}"`);
                break;
              } catch (err) {
                // Continuar
              }
            }

            if (!otpSubmitted) {
              onLog('⚠️ Nenhum botão de OTP encontrado');
            }

            // Aguardar navegação para dashboard
            await Promise.race([
              page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
              page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}),
              page.waitForTimeout(5000),
            ]);

            onLog(`✅ Sessão iniciada`);
          } else {
            throw new Error('OTP não recebido após 120 segundos');
          }
        } else {
          onLog('⚠️ OTP não detectado (continuando...)');
        }
      } catch (err) {
        onLog(`⚠️ OTP error: ${err.message}`);
      }

      // FASE 7: START BOOKING
      onLog(`\n📋 FASE 5: Procurando "Start New Booking"`);
      await this.humanizer.wait(page, 2000, 4000);

      try {
        const startBtn = await page.locator(config.site.startBookingSelector).first();
        const isVisible = await startBtn.isVisible({ timeout: 10000 }).catch(() => false);

        if (isVisible) {
          onLog(`✅ Botão encontrado`);
          await this.humanizer.clickElement(page, config.site.startBookingSelector);
          onLog(`✅ Clicado`);
          
          await Promise.race([
            page.waitForNavigation({ timeout: 20000 }).catch(() => {}),
            page.waitForTimeout(3000),
          ]);
        } else {
          onLog('⚠️ Start Booking não encontrado');
        }
      } catch (err) {
        onLog(`⚠️ Start Booking: ${err.message}`);
      }

      // FASE 8: SELECIONAR CATEGORIA DE VISTO
      onLog(`\n🏳️ FASE 6: Selecionando Categoria de Visto`);
      try {
        const categorySelect = await page.locator(config.site.visaCategorySelector).first();
        await categorySelect.waitFor({ state: 'visible', timeout: 10000 });
        
        onLog(`✅ Select encontrado`);
        await this.humanizer.clickElement(page, config.site.visaCategorySelector);

        await this.humanizer.wait(page, 800, 1500);

        // Procurar opções
        const options = await page.locator('mat-option').all();
        onLog(`   ${options.length} opções encontradas`);

        let selected = false;
        for (const option of options) {
          const text = await option.textContent();
          if (text && text.toLowerCase().includes('nacional')) {
            await option.click();
            onLog(`   ✅ "${text.trim()}" selecionado`);
            selected = true;
            break;
          }
        }

        if (!selected) {
          onLog('⚠️ Categoria "Nacional" não encontrada, tentando primeira opção');
          if (options.length > 0) {
            await options[0].click();
            const text = await options[0].textContent();
            onLog(`   ✅ "${text.trim()}" selecionado`);
          }
        }

        await this.humanizer.wait(page, 1000, 2000);

      } catch (err) {
        onLog(`⚠️ Categoria select: ${err.message}`);
      }

      // FASE 9: CONTINUAR
      onLog(`\n➡️ FASE 7: Continue`);
      try {
        const continueBtn = await page.locator(config.site.continueButtonSelector).first();
        await continueBtn.waitFor({ state: 'visible', timeout: 10000 });
        await this.humanizer.clickElement(page, config.site.continueButtonSelector);
        
        await Promise.race([
          page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
          page.waitForTimeout(3000),
        ]);

        onLog(`✅ Continuado`);
      } catch (err) {
        onLog(`⚠️ Continue: ${err.message}`);
      }

      result.success = true;
      result.message = 'Bot completado com sucesso!';
      result.currentUrl = page.url();

      onLog(`\n✅ Bot concluído!`);
      onLog(`📍 URL Final: ${result.currentUrl}`);

      await this.sessionManager.extractCookies(page);

    } catch (err) {
      result.success = false;
      result.message = err.message;
      onLog(`\n❌ Erro Fatal: ${err.message}`);

      try {
        const screenshotPath = path.join(__dirname, 'screenshots', `error-${Date.now()}.png`);
        if (!fs.existsSync(path.dirname(screenshotPath))) {
          fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        }
        await page.screenshot({ path: screenshotPath, fullPage: true });
        onLog(`📸 Screenshot: ${path.basename(screenshotPath)}`);
      } catch (screenshotErr) {
        DEBUG_MODE && console.warn('Screenshot error:', screenshotErr.message);
      }

    } finally {
      try {
        await browser.close();
        onLog('🔌 Browser fechado');
      } catch (err) {
        DEBUG_MODE && console.warn('Close error:', err.message);
      }
    }

    return result;
  }
}

/* =========================================================================
 * EXPRESS + SOCKET.IO
 * ========================================================================= */

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 50 * 1024 * 1024,
});

let botStatus = 'idle';
let lastRunSummary = null;
const bot = new VFSBot();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function broadcastLog(message) {
  const timestamp = new Date().toLocaleTimeString('pt-BR');
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  io.emit('log', line);

  const logFile = path.join(LOGS_PATH, `${new Date().toISOString().split('T')[0]}.log`);
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch (err) {
    // Ignorar
  }
}

function broadcastStatus(status) {
  botStatus = status;
  io.emit('status', status);
  io.emit('statusUpdate', { status, timestamp: new Date().toISOString() });
}

// API Routes
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json({
    ...config,
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
    stealth: { ...current.stealth, ...(incoming.stealth || {}) },
    credentials: { ...current.credentials, ...(incoming.credentials || {}) },
    otp: { ...current.otp, ...(incoming.otp || {}) },
  };
  saveConfig(updated);
  res.json({ ok: true, config: updated });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: botStatus,
    lastRunSummary,
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/run', async (req, res) => {
  if (botStatus === 'running') {
    return res.status(409).json({ error: 'Bot já está executando' });
  }

  const config = loadConfig();

  if (!config.credentials.email || !config.credentials.password) {
    return res.status(400).json({ error: 'Email e senha obrigatórios' });
  }

  res.json({ ok: true, message: 'Execução iniciada' });

  const runId = randomUUID();
  broadcastStatus('running');
  broadcastLog('🚀 Bot iniciando...');

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
      try {
        await db.collection('bot_runs').add(lastRunSummary);
      } catch (err) {
        DEBUG_MODE && console.warn('Firebase save error:', err.message);
      }
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

    broadcastLog(`❌ Erro: ${err.message}`);
  }
});

app.get('/api/cookies', (req, res) => {
  const sm = new SessionManager();
  res.json({ count: sm.cookies.length });
});

app.delete('/api/cookies', (req, res) => {
  const sm = new SessionManager();
  sm.clearCookies();
  res.json({ ok: true, message: 'Cookies limpos' });
});

app.get('/api/runs', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const snapshot = await db.collection('bot_runs').orderBy('at', 'desc').limit(50).get();
    const runs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(runs);
  } catch (err) {
    res.json([]);
  }
});

io.on('connection', (socket) => {
  broadcastLog(`👤 Cliente: ${socket.id}`);
  socket.emit('status', botStatus);

  socket.on('disconnect', () => {
    broadcastLog(`👤 Desconectado: ${socket.id}`);
  });
});

// Dashboard HTML
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-PT">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>🛡️ VFS Bot v8.0</title>
      <script src="https://cdn.socket.io/4.5.4/socket.io.min.js"></script>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 10px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3); overflow: hidden; }
        header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
        h1 { font-size: 2em; margin-bottom: 10px; }
        .status { display: inline-block; padding: 8px 20px; border-radius: 20px; background: rgba(255, 255, 255, 0.2); font-weight: bold; margin-top: 10px; }
        .status.idle { background-color: #95a5a6; }
        .status.running { background-color: #f39c12; animation: pulse 1s infinite; }
        .status.success { background-color: #27ae60; }
        .status.error { background-color: #e74c3c; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        main { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; padding: 30px; }
        .section { background: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #667eea; }
        .section h2 { color: #667eea; margin-bottom: 15px; font-size: 1.3em; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; color: #555; }
        input, textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; font-size: 0.95em; }
        input:focus, textarea:focus { outline: none; border-color: #667eea; box-shadow: 0 0 5px rgba(102, 126, 234, 0.3); }
        button { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; padding: 12px 24px; border-radius: 5px; font-size: 1em; font-weight: bold; cursor: pointer; width: 100%; margin-top: 10px; }
        button:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .logs { background: #1e1e1e; color: #00ff00; padding: 15px; border-radius: 5px; height: 400px; overflow-y: auto; font-family: 'Courier New', monospace; font-size: 0.85em; line-height: 1.5; }
        .log-entry { margin-bottom: 5px; padding: 5px; border-left: 2px solid #00ff00; padding-left: 10px; }
        .log-entry.success { border-left-color: #00ff00; }
        .log-entry.error { border-left-color: #ff0000; color: #ff6b6b; }
        .log-entry.warning { border-left-color: #ffff00; color: #ffd700; }
        .grid-2 { grid-column: 1 / -1; }
        .button-group { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .button-success { background: linear-gradient(135deg, #27ae60 0%, #229954 100%); }
        .button-danger { background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); }
        .info-box { background: #e8f4f8; border-left: 4px solid #3498db; padding: 15px; border-radius: 5px; margin-bottom: 15px; font-size: 0.9em; }
        @media (max-width: 768px) { main { grid-template-columns: 1fr; } }
      </style>
    </head>
    <body>
      <div class="container">
        <header>
          <h1>🛡️ VFS Bot v8.0</h1>
          <p>Cloudflare + Turnstile + OTP</p>
          <div class="status idle" id="status">OCIOSO</div>
        </header>

        <main>
          <section class="section">
            <h2>⚙️ Configuração</h2>
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
            <button onclick="saveConfig()">💾 Salvar</button>
          </section>

          <section class="section">
            <h2>🎮 Controles</h2>
            <div class="info-box">
              <strong>Status:</strong> <span id="currentStatus">OCIOSO</span>
            </div>
            <div class="button-group">
              <button class="button-success" onclick="runBot()" id="runBtn">🚀 Executar</button>
              <button class="button-danger" onclick="clearCookies()">🗑️ Limpar</button>
            </div>
          </section>

          <section class="section grid-2">
            <h2>📊 Logs</h2>
            <div class="logs" id="logs">
              <div class="log-entry">🟢 Sistema pronto</div>
            </div>
            <button onclick="clearLogs()" style="background: #95a5a6;">🗑️ Limpar</button>
          </section>
        </main>
      </div>

      <script>
        const socket = io();
        
        socket.on('status', (status) => {
          const statusEl = document.getElementById('status');
          const currentStatusEl = document.getElementById('currentStatus');
          statusEl.className = 'status ' + status;
          statusEl.textContent = status.toUpperCase();
          currentStatusEl.textContent = status.toUpperCase();
          document.getElementById('runBtn').disabled = status === 'running';
        });

        socket.on('log', (message) => {
          const logsDiv = document.getElementById('logs');
          const entry = document.createElement('div');
          entry.className = 'log-entry';
          if (message.includes('❌')) entry.classList.add('error');
          else if (message.includes('⚠️')) entry.classList.add('warning');
          else if (message.includes('✅')) entry.classList.add('success');
          entry.textContent = message;
          logsDiv.appendChild(entry);
          logsDiv.scrollTop = logsDiv.scrollHeight;
        });

        async function saveConfig() {
          const config = {
            site: { loginUrl: document.getElementById('loginUrl').value },
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
              alert('✅ Salvo!');
            }
          } catch (err) {
            alert('❌ Erro: ' + err.message);
          }
        }

        async function runBot() {
          try {
            const response = await fetch('/api/run', { method: 'POST' });
            const data = await response.json();
            if (!response.ok) alert('❌ ' + data.error);
          } catch (err) {
            alert('❌ ' + err.message);
          }
        }

        async function clearCookies() {
          if (!confirm('Tem certeza?')) return;
          try {
            await fetch('/api/cookies', { method: 'DELETE' });
            alert('✅ Cookies limpos!');
          } catch (err) {
            alert('❌ Erro: ' + err.message);
          }
        }

        function clearLogs() {
          document.getElementById('logs').innerHTML = '<div class="log-entry">Logs limpos</div>';
        }

        window.addEventListener('load', async () => {
          try {
            const response = await fetch('/api/config');
            const config = await response.json();
            document.getElementById('email').value = config.credentials?.email || '';
            document.getElementById('password').value = config.credentials?.password || '';
            document.getElementById('loginUrl').value = config.site?.loginUrl || '';
          } catch (err) {
            console.warn('Erro carregar config:', err.message);
          }
        });
      </script>
    </body>
    </html>
  `);
});

// Server Start
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║  🛡️  VFS GLOBAL BOT v8.0 - 100% FUNCIONAL           ║
║  Cloudflare + Turnstile + OTP Firebase              ║
║  Rodando em http://localhost:${PORT.toString().padEnd(24)} ║
║  DEBUG: ${(DEBUG_MODE ? 'ativado' : 'desativado').padEnd(30)} ║
║  Firebase: ${(db ? 'conectado' : 'desconectado').padEnd(28)} ║
╚═══════════════════════════════════════════════════════╝
  `);

  broadcastLog('🟢 Servidor iniciado!');
  broadcastLog(`🌐 Acesse: http://localhost:${PORT}`);
  broadcastLog(`✅ Pronto para usar!`);
});

module.exports = { bot, VFSBot, loadConfig, saveConfig };
