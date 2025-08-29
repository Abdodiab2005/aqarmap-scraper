// src/utils/wgcf.js
require("dotenv").config();
const { exec } = require("child_process");
const util = require("util");
const execp = util.promisify(exec);
const logger = require("./logger");

const SUDO = process.env.SUDO_BIN || "sudo";
const IFACE = process.env.WGCF_IFACE || "wgcf";

/** تنفيذ آمن مع لوج */
async function sh(cmd) {
  try {
    const { stdout, stderr } = await execp(cmd, { timeout: 60_000 });
    if (stderr && stderr.trim()) logger.debug({ cmd, stderr }, "[wgcf] stderr");
    return stdout.trim();
  } catch (e) {
    const msg = String(e?.stderr || e?.stdout || e?.message || e);
    throw new Error(msg.trim());
  }
}

/** هل الواجهة موجودة ومرفوعة؟ */
async function ifaceExists() {
  try {
    await sh(`ip link show ${IFACE}`);
    return true;
  } catch {
    return false;
  }
}

/** قراءة الـ IP الخارجي عبر Cloudflare trace (IPv4) */
async function getPublicIP() {
  try {
    const out = await sh(
      `curl -4 -s --max-time 5 https://www.cloudflare.com/cdn-cgi/trace | sed -n 's/^ip=//p'`
    );
    return (out || "").trim();
  } catch {
    return "";
  }
}

/** رفع الواجهة (لو موجودة بالفعل نتعامل كنجاح) */
async function up() {
  try {
    await sh(`${SUDO} wg-quick up ${IFACE}`);
    logger.info("[wgcf] interface brought UP");
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes("already exists")) {
      logger.debug("[wgcf] up: interface already exists (OK)");
      return;
    }
    // أحيانًا يكون السبب أنها مرفوعة جزئيًا — جرّب down ثم up
    if (msg.toLowerCase().includes("file exists") || msg.includes("already")) {
      await down();
      await sh(`${SUDO} wg-quick up ${IFACE}`);
      logger.info("[wgcf] interface re-UP after partial state");
      return;
    }
    throw e;
  }
}

/** تنزيل الواجهة (لو مش موجودة نتجاهل الخطأ) */
async function down() {
  try {
    await sh(`${SUDO} wg-quick down ${IFACE}`);
    logger.info("[wgcf] interface brought DOWN");
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes("does not exist")) {
      logger.debug("[wgcf] down: interface not present (OK)");
      return;
    }
    // في كل الأحوال ما نوقفش البايبلاين بسبب down
    logger.debug({ err: msg }, "[wgcf] down error (ignored)");
  }
}

/** تأكيد تشغيل الواجهة بدون رمي Error لو already up */
async function ensureUp() {
  // فحص سريع
  if (await ifaceExists()) {
    logger.debug("[wgcf] ensureUp: interface exists");
    return;
  }
  try {
    await up();
  } catch (e) {
    // لو الرسالة "already exists" اعتبره نجاح
    const msg = String(e.message || e);
    if (msg.includes("already exists")) return;
    throw e;
  }
}

/** قفل للتدوير كي لا يحدث overlap */
let rotateLock = Promise.resolve();

/**
 * تدوير الواجهة + (اختياري) انتظار تغيّر الـ IP الخارجي
 * البيئة:
 *  - WARP_WAIT_FOR_IP_CHANGE=1 لتفعيل الانتظار (افتراضي 1)
 *  - WARP_MAX_IP_CHECKS=20   عدد المحاولات (افتراضي 20)
 *  - WARP_IP_CHECK_INTERVAL_MS=1500 فترة بين المحاولات (افتراضي 1500ms)
 */
function rotate() {
  rotateLock = rotateLock
    .then(async () => {
      const waitForChange =
        (process.env.WARP_WAIT_FOR_IP_CHANGE || "0") === "1";

      const maxChecks = Number(process.env.WARP_MAX_IP_CHECKS || 20);
      const interval = Number(process.env.WARP_IP_CHECK_INTERVAL_MS || 1500);

      const oldIP = waitForChange ? await getPublicIP() : "";
      logger.info({ oldIP }, "[wgcf] rotating…");

      await down();
      await up();

      // اختياري: فلش كاش DNS (لو systemd-resolved)
      await sh(
        `which resolvectl >/dev/null 2>&1 && ${SUDO} resolvectl flush-caches || true`
      ).catch(() => {});

      if (waitForChange) {
        for (let i = 1; i <= maxChecks; i++) {
          const ip = await getPublicIP();
          logger.debug({ attempt: i, ip }, "[wgcf] probing new IP");
          if (ip && ip !== oldIP) {
            logger.info({ oldIP, newIP: ip }, "[wgcf] IP changed");
            return;
          }
          await new Promise((r) => setTimeout(r, interval));
        }
        logger.warn(
          { oldIP },
          "[wgcf] IP did not change within limit (continuing anyway)"
        );
      } else {
        // انتظار بسيط لو مش متابعين IP
        await new Promise((r) => setTimeout(r, 1500));
      }
    })
    .catch((e) => {
      // ما نكسرّش سلسلة الوعود
      logger.warn(
        { err: String(e?.message || e) },
        "[wgcf] rotate failed (ignored)"
      );
    });

  return rotateLock;
}

module.exports = { ensureUp, rotate, up, down, getPublicIP };
