// src/phones/phoneFetcher.js
require("dotenv").config();
const axios = require("axios");
const fs = require("fs").promises;
const logger = require("../utils/logger");
const { rotate, ensureUp, getPublicIP } = require("../utils/wgcf");
const { refreshAuthViaBrowser } = require("../auth/refresh");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function buildHeaders(auth, referer) {
  return {
    "User-Agent": "...",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Expires: "-1",
    Origin: "https://aqarmap.com.eg",
    Referer: referer || "https://aqarmap.com.eg/", // 👈 جديد
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Sec-GPC": "1",
    DNT: "1",
    TE: "Trailers",
    Cookie: auth.cookie || "",
    authorization: auth.authorization || "",
  };
}

async function loadAuth(authFile) {
  try {
    return JSON.parse(await fs.readFile(authFile, "utf8"));
  } catch {
    return { cookie: "", authorization: "" };
  }
}
async function saveAuth(authFile, obj) {
  await fs.writeFile(authFile, JSON.stringify(obj, null, 2));
}

function extractListingId(url) {
  const m = url.match(/listing\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchPhonesOnce({
  listingId,
  isWhatsApp,
  apiBase,
  leadEndpoint,
  headers,
}) {
  const payload = {
    fullName: "Abdo Diab",
    email: "awkward.anaconda.pszq@rapidletter.net",
    phone: { number: "+447414848196", country_code: "+44" },
    source: "ws-listing_details_fixed_buttons",
    type: isWhatsApp ? 11 : 1,
  };
  const url = `${apiBase}/${listingId}${leadEndpoint}`;
  const res = await axios.post(url, payload, { headers, timeout: 30000 });
  const phones = res?.data?.lead?.listing?.listing_phones || [];
  return { phones: phones.map((p) => p.number), leadId: res?.data?.lead_id };
}

/**
 * Stage التليفونات — متسلسلة (أكثر أمانًا ضد الـ rate limit)
 * - تدوير wgcf بعد N طلبات أو عند 429
 * - عند 401: تدوير + تجديد توكن Headless + إعادة المحاولة
 * - Logs تفصيلية لكل خطوة
 */
async function runPhoneStage({
  baseUrl,
  authFile,
  cookiesFile,
  detailsCollection,
  targetsName,
  cfgPhones, // { apiBase, leadEndpoint, rotateEvery, delayBetween, maxRetries }
}) {
  const rotateEvery = Number(
    process.env.PHONE_ROTATE_EVERY || cfgPhones.rotateEvery || 8
  );
  const delayBetween = Number(
    process.env.PHONE_DELAY_BETWEEN_MS || cfgPhones.delayBetween || 1000
  );
  const maxRetries = Number(
    process.env.PHONE_MAX_RETRIES || cfgPhones.maxRetries || 3
  );

  await ensureUp().catch((e) =>
    logger.warn(
      { err: String(e?.message || e) },
      "[phones] wgcf ensureUp failed (continuing)"
    )
  );
  let auth = await loadAuth(authFile);

  // لو مفيش توكن/كوكيز — جدّد مبدئيًا
  if (!auth.cookie || !auth.authorization) {
    logger.info("[phones] no auth found, refreshing first…");
    auth = await refreshAuthViaBrowser({
      baseUrl,
      cookiesFile,
      authFile,
    }).catch((e) => {
      logger.warn(
        { err: String(e?.message || e) },
        "[phones] initial refresh failed"
      );
      return auth;
    });
  }

  const query = {
    $or: [
      { phoneNumber: null },
      { phoneNumber: { $exists: false } },
      // لو كانت Array فاضية
      // هنتعامل مع الفاضي لما نقرأ الوثيقة ونحدثها
    ],
  };

  const cursor = detailsCollection.find(query, { projection: { url: 1 } });
  let processed = 0;
  let rotateCounter = 0;
  const t0 = Date.now();

  logger.info({ target: targetsName }, "[phones] starting");

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const listingId = extractListingId(doc.url);
    if (!listingId) {
      logger.debug({ url: doc.url }, "[phones] skipped (no listingId)");
      continue;
    }

    // تدوير دوري
    // تدوير دوري + IP قبل/بعد
    if (rotateCounter >= rotateEvery) {
      const beforeIP = await getPublicIP().catch(() => "");
      logger.info(
        { rotateEvery, beforeIP },
        "[phones] rotating wgcf (periodic)"
      );
      await rotate();
      const afterIP = await getPublicIP().catch(() => "");
      logger.info(
        { rotateEvery, beforeIP, afterIP },
        "[phones] rotate done (periodic)"
      );
      rotateCounter = 0;
      await delay(1200);
    }

    let attempt = 0;
    let ok = false;

    while (attempt < maxRetries && !ok) {
      attempt++;
      try {
        const referer = `https://aqarmap.com.eg/ar/listing/${listingId}/`;
        const headers = buildHeaders(auth, referer);
        logger.debug({ listingId, attempt }, "[phones] request (normal)");
        const { phones, leadId } = await fetchPhonesOnce({
          listingId,
          isWhatsApp: false,
          apiBase: cfgPhones.apiBase,
          leadEndpoint: cfgPhones.leadEndpoint,
          headers,
        });

        await detailsCollection.updateOne(
          { url: doc.url },
          {
            $set: {
              phoneNumber: phones,
              leadId,
              phoneUpdatedAt: new Date(),
              lastPhoneResult: "ok",
            },
          }
        );

        ok = true;
        logger.info({ listingId, phones }, "[phones] number fetched");
      } catch (err) {
        const status = err?.response?.status;
        const msg = String(err?.message || err);
        logger.warn(
          { listingId, attempt, status, err: msg },
          "[phones] request failed"
        );

        if (status === 429) {
          const beforeIP = await getPublicIP().catch(() => "");
          logger.info(
            { listingId, beforeIP },
            "[phones] 429 => rotate wgcf + backoff"
          );

          // تدوير سريع (من غير انتظار تغيّر IP لو WARP_WAIT_FOR_IP_CHANGE=0)
          await rotate();

          const afterIP = await getPublicIP().catch(() => "");
          logger.info({ listingId, beforeIP, afterIP }, "[phones] rotate done");

          // backoff أهدى (3~6 ثواني مع jitter) + reset للعداد
          rotateCounter = 0;
          const jitter = 3000 + Math.floor(Math.random() * 3000);
          await delay(jitter);

          // لو دي تاني 429 على نفس الإعلان في نفس الجلسة، جدّد التوكن كمان
          if (attempt >= 2) {
            logger.info({ listingId }, "[phones] 429 again => refresh auth");
            auth = await refreshAuthViaBrowser({
              baseUrl,
              cookiesFile,
              authFile,
            }).catch((e) => {
              logger.warn(
                { err: String(e?.message || e) },
                "[phones] refresh failed"
              );
              return auth;
            });
            await delay(1000);
          }

          continue;
        }

        if (status === 401) {
          logger.info(
            { listingId },
            "[phones] 401 => rotate + refresh auth via browser (headless)"
          );
          await rotate().catch((e) =>
            logger.warn(
              { err: String(e?.message || e) },
              "[phones] rotate failed"
            )
          );

          auth = await refreshAuthViaBrowser({
            baseUrl,
            cookiesFile,
            authFile,
          }).catch((e) => {
            logger.warn(
              { err: String(e?.message || e) },
              "[phones] refresh failed"
            );
            return auth;
          });
          await delay(1000);
          continue;
        }

        if (attempt >= maxRetries) {
          await detailsCollection.updateOne(
            { url: doc.url },
            {
              $set: {
                phoneError: msg,
                phoneUpdatedAt: new Date(),
                lastPhoneResult: "error",
              },
            }
          );
        } else {
          await delay(1000 * attempt);
        }
      }
    }

    // محاولة واتساب (اختيارية) بعد النجاح
    if (ok) {
      try {
        const headers = buildHeaders(auth);
        logger.debug({ listingId }, "[phones] request (whatsapp)");
        const { phones, leadId } = await fetchPhonesOnce({
          listingId,
          isWhatsApp: true,
          apiBase: cfgPhones.apiBase,
          leadEndpoint: cfgPhones.leadEndpoint,
          headers,
        });
        await detailsCollection.updateOne(
          { url: doc.url },
          {
            $set: {
              whatsappNumber: phones,
              whatsappLeadId: leadId,
              whatsappUpdatedAt: new Date(),
            },
          }
        );
      } catch (e) {
        logger.debug(
          { listingId, err: String(e?.message || e) },
          "[phones] whatsapp failed (ignored)"
        );
      }
    }

    processed++;
    rotateCounter++;
    if (processed % 10 === 0) {
      logger.info(
        { processed, elapsedSec: Math.round((Date.now() - t0) / 1000) },
        "[phones] progress"
      );
    }

    await delay(delayBetween);
  }

  logger.info(
    { processed, totalSec: Math.round((Date.now() - t0) / 1000) },
    "[phones] done"
  );
  return { processed };
}

module.exports = { runPhoneStage };
