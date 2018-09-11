/*
 Copyright 2018 Google Inc. All Rights Reserved.
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
*/

import {keys, get, set, Store} from 'idb-keyval';
import parseAppCacheManifest from 'parse-appcache-manifest';

import constants from './lib/constants.mjs';

/**
 * Main entry point that kicks off the whole process.
 */
async function init() {
  const swScript = document.currentScript.dataset.serviceWorker;
  const manifestAttribute = document.documentElement.getAttribute('manifest');

  if (manifestAttribute && ('serviceWorker' in navigator)) {
    const manifestUrl = (new URL(manifestAttribute, location.href)).href;

    const hash = await checkManifestVersion(manifestUrl);
    await updateManifestAssociationForCurrentPage(manifestUrl, hash);

    if (swScript) {
      await navigator.serviceWorker.register(swScript);
    }
  }
}

/**
 * Caches the Responses for one or more URLs, using the Cache Storage API.
 *
 * @private
 * @param {String} hash
 * @param {Array<String>} urls
 * @return {Promise<T>}
 */
async function addToCache(hash, urls) {
  // Use the manifest hash as the name of the cache to open.
  const cache = await caches.open(hash);

  const fetchOperations = urls.map(async (url) => {
    // See Item 18.3 of https://html.spec.whatwg.org/multipage/browsers.html#downloading-or-updating-an-application-cache
    const request = new Request(url, {
      credentials: 'include',
      headers: {
        'X-Use-Fetch': true,
      },
      redirect: 'manual',
    });

    try {
      const response = await fetch(request);

      const cacheControl = response.headers.get('Cache-Control');
      if (cacheControl && cacheControl.includes('no-store')) {
        // Bail early if we're told not to cache this response.
        return;
      }

      if (response.ok) {
        await cache.put(url, response);
      } else if (response.status !== 404 && response.status !== 410) {
        // See Item 18.5 of https://html.spec.whatwg.org/multipage/browsers.html#downloading-or-updating-an-application-cache
        throw new Error(`Response code of ${response.status} was returned.`);
      }
    } catch (error) {
      // We're here if one of the following happens:
      // - The fetch() rejected due to a NetworkError.
      // - The HTTP status code from the fetch() was something other than
      //   200, 404, and 410 AND the response isn't Cache-Control: no-store
      const response = await caches.match(url);
      if (response) {
        // Add a copy of the cached response to this new cache, if it exists.
        await cache.put(url, response);
      }
    }
  });

  await Promise.all(fetchOperations);
}

/**
 * Gets the text of a manifest, given its URL.
 * If the manifest was retrieved from the HTTP cache and it's older than
 * constants.MAX_MANIFEST_AGE, then we get it again, bypassing the HTTP cache.
 *
 * @param {String} manifestUrl
 * @return {Promise<String>}
 */
async function getManifestText(manifestUrl) {
  // See Item 4 of https://html.spec.whatwg.org/multipage/browsers.html#downloading-or-updating-an-application-cache
  const manifestRequest = new Request(manifestUrl, {
    credentials: 'include',
    headers: {
      'X-Use-Fetch': true,
    },
  });

  // TODO: Handle manifest fetch failure errors.
  const manifestResponse = await fetch(manifestRequest);
  const dateHeaderValue = manifestResponse.headers.get('date');
  if (dateHeaderValue) {
    const manifestDate = new Date(dateHeaderValue).valueOf();
    // Calculate the age of the manifest in milliseconds.
    const manifestAgeInMillis = Date.now() - manifestDate;
    // If the manifest is too old, then we refetch without hitting the cache.
    if (manifestAgeInMillis > constants.MAX_MANIFEST_AGE) {
      const noCacheRequest = new Request(manifestUrl, {
        credentials: 'include',
        // See https://fetch.spec.whatwg.org/#requestcache
        cache: 'reload',
        headers: {
          'X-Use-Fetch': true,
        },
      });

      const noCacheResponse = await fetch(noCacheRequest);
      return noCacheResponse.text();
    }
  }

  // If the initial manifest response is fresh enough, return that.
  return manifestResponse.text();
}

/**
 * Given a manifest URL and contents, returns a hex representation of the hash.
 *
 * @param {String} manifestUrl
 * @param {String} manifestText
 * @return {Promise<String>}
 */
async function generateHash(manifestUrl, manifestText) {
  // Hash a combination of URL and text so that two identical manifests
  // served from a different location are treated distinctly.
  const source = new TextEncoder('utf-8').encode(manifestUrl + manifestText);
  const hashBytes = await crypto.subtle.digest('SHA-256', source);

  // See https://stackoverflow.com/a/50767210/385997
  const hashString = Array.from(new Uint8Array(hashBytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return hashString;
}

/**
 * Compares the copy of a manifest obtained from fetch() with the copy stored
 * in IndexedDB. If they differ, it kicks off the manifest update process.
 *
 * It returns a Promise which fulfills with the hash for the current manifest.
 *
 * @private
 * @param {String} manifestUrl
 * @return {Promise<String>}
 */
async function checkManifestVersion(manifestUrl) {
  const store = new Store(constants.STORES.MANIFEST_URL_TO_CONTENTS,
    constants.STORES.MANIFEST_URL_TO_CONTENTS);

  const currentManifestText = await getManifestText(manifestUrl);
  const currentManifestHash = await generateHash(manifestUrl,
    currentManifestText);

  const previousManifests = await get(manifestUrl, store) || [];
  const isManifestKnown = previousManifests.some((previousManifest) => {
    return previousManifest.hash === currentManifestHash;
  });

  if (!isManifestKnown) {
    // If the hash of the manifest retrieved from the network isn't already
    // in the list of known manifest hashes, then trigger an update.
    await performManifestUpdate(manifestUrl, currentManifestHash,
      currentManifestText, previousManifests);
  }

  return currentManifestHash;
}

/**
 * Parses the newest manifest text into the format described at
 * https://www.npmjs.com/package/parse-appcache-manifest
 * The parsed manifest is stored in IndexedDB.
 * This also calls addToCache() to cache the relevant URLs from the manifest.
 *
 * It returns a Promise which fulfills with the hash for the current manifest.
 *
 * @private
 * @param {String} manifestUrl
 * @param {String} manifestHash
 * @param {String} manifestText
 * @param {Array<Object>} previousManifests
 * @return {Promise<String>}
 */
async function performManifestUpdate(
  manifestUrl, manifestHash, manifestText, previousManifests
) {
  const parsedManifest = makeManifestUrlsAbsolute(manifestUrl,
    parseAppCacheManifest(manifestText));

  previousManifests.push({
    hash: manifestHash,
    parsed: parsedManifest,
  });

  const fallbackUrls = Object.keys(parsedManifest.fallback)
    .map((key) => parsedManifest.fallback[key]);

  const urlsToCache = parsedManifest.cache.concat(fallbackUrls);

  // All the master entries, i.e. those pages that were associated with an older
  // version of the manifest at the same URL, should be copied over to the new
  // cache as well.
  const pathToManifestStore = new Store(constants.STORES.PATH_TO_MANIFEST,
    constants.STORES.PATH_TO_MANIFEST);
  const urls = await keys(pathToManifestStore);
  for (const url of urls) {
    const possibleManifestUrl = await get(url, pathToManifestStore);
    if (possibleManifestUrl === manifestUrl) {
      urlsToCache.push(url);
    }
  }

  const manifestUrlToContentsStore = new Store(
    constants.STORES.MANIFEST_URL_TO_CONTENTS,
    constants.STORES.MANIFEST_URL_TO_CONTENTS);

  await Promise.all([
    addToCache(manifestHash, urlsToCache),
    set(manifestUrl, previousManifests, manifestUrlToContentsStore),
  ]);

  return manifestHash;
}

/**
 * Updates IndexedDB to indicate that the current page's URL is associated
 * with the AppCache manifest at manifestUrl.
 * It also adds the current page to the cache versioned with hash, matching
 * the master entry cache-as-you-go behavior you get with AppCache.
 *
 * @private
 * @param {String} manifestUrl
 * @param {String} hash
 */
async function updateManifestAssociationForCurrentPage(manifestUrl, hash) {
  const store = new Store(constants.STORES.PATH_TO_MANIFEST,
    constants.STORES.PATH_TO_MANIFEST);
  await Promise.all([
    addToCache(hash, [location.href]),
    set(location.href, manifestUrl, store),
  ]);
}

/**
 * Converts all the URLs in a given manifest's CACHE, NETWORK, and FALLBACK
 * sections to be absolute URLs.
 *
 * @private
 * @param {String} baseUrl
 * @param {Object} originalManifest
 * @return {Object}
 */
function makeManifestUrlsAbsolute(baseUrl, originalManifest) {
  const manifest = {};

  manifest.cache = originalManifest.cache
    .map((relativeUrl) => (new URL(relativeUrl, baseUrl)).href);

  manifest.network = originalManifest.network.map((relativeUrl) => {
    if (relativeUrl === '*') {
      return relativeUrl;
    }

    return (new URL(relativeUrl, baseUrl)).href;
  });

  manifest.fallback = {};
  for (const key of Object.keys(originalManifest.fallback)) {
    manifest.fallback[(new URL(key, baseUrl)).href] =
      (new URL(originalManifest.fallback[key], baseUrl)).href;
  }

  return manifest;
}

init();
