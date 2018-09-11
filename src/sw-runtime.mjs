/*
 Copyright 2016 Google Inc. All Rights Reserved.
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

import {del, keys, get, set, Store} from 'idb-keyval';

import constants from './lib/constants.mjs';

// Ensure that only one cleanup is taking place at once.
let cleanupInProgress = false;

/**
 * Determines what the most likely URL is associated with the client page from
 * which the event's request originates. This is used to determine which
 * AppCache manifest's rules should be applied.
 *
 * @private
 * @param {FetchEvent} event
 * @return {Promise<String>} The client URL
 */
async function getClientUrlForEvent(event) {
  try {
    const client = await self.clients.get(event.clientId);
    return client.url;
  } catch (error) {
    // Firefox currently sets the referer to 'about:client' for initial
    // navigations, but that's not useful for our purposes.
    if (event.request.referrer &&
        event.request.referrer !== 'about:client') {
      return event.request.referrer;
    }

    // Use the event's request URL as the last resort, with the assumption
    // that this is a navigation request.
    return event.request.url;
  }
}

/**
 * Finds the longest matching prefix, given an array of possible matches.
 *
 * @private
 * @param {Array<String>} urlPrefixes
 * @param {String} fullUrl
 * @return {String} The longest matching prefix, or '' if none match
 */
function longestMatchingPrefix(urlPrefixes, fullUrl) {
  return urlPrefixes
    .filter((urlPrefix) => fullUrl.startsWith(urlPrefix))
    .reduce((longestSoFar, current) => {
      return (longestSoFar.length >= current.length) ? longestSoFar : current;
    }, '');
}

/**
 * Performs a fetch(), using a cached response as a fallback if that fails.
 *
 * @private
 * @param {Request} request
 * @param {String} fallbackUrl
 * @param {String} cacheName
 * @return {Promise<Response>}
 */
async function fetchWithFallback(request, fallbackUrl, cacheName) {
  try {
    const response = await fetch(request);

    // Successful but error-like responses are treated as failures.
    // Ditto for redirects to other origins.
    if (!response.ok ||
        (new URL(response.url).origin !== self.location.origin)) {
      throw new Error('Request failure.');
    }

    return response;
  } catch (error) {
    return caches.match(fallbackUrl, {cacheName});
  }
}

/**
 * Checks IndexedDB for a manifest with a given URL. If found, it fulfills
 * with info about the latest version.
 *
 * @private
 * @param {String} manifestUrl
 * @return {Promise<Object>}
 */
async function getLatestManifestVersion(manifestUrl) {
  const store = new Store(constants.STORES.MANIFEST_URL_TO_CONTENTS,
    constants.STORES.MANIFEST_URL_TO_CONTENTS);
  const manifests = await get(manifestUrl, store);
  if (manifests && manifests.length) {
    return manifests[manifests.length - 1];
  }
}

/**
 * Checks IndexedDB for a manifest with a given URL, versioned with the
 * given hash. If found, it fulfills with the parsed manifest.
 *
 * @private
 * @param {String} manifestUrl
 * @param {String} manifestHash
 * @return {Promise<Object>}
 */
async function getParsedManifestVersion(manifestUrl, manifestHash) {
  const store = new Store(constants.STORES.MANIFEST_URL_TO_CONTENTS,
    constants.STORES.MANIFEST_URL_TO_CONTENTS);
  const manifests = await get(manifestUrl, store) || [];

  for (const manifest of manifests) {
    if (manifest.hash === manifestHash) {
      return manifest.parsed;
    }
  }
}

/**
 * Updates the CLIENT_ID_TO_HASH store in IndexedDB with the client id to
 * hash association.
 *
 * @private
 * @param {String} clientId
 * @param {String} hash
 */
async function saveClientIdAndHash(clientId, hash) {
  if (clientId) {
    const store = new Store(constants.STORES.CLIENT_ID_TO_HASH,
      constants.STORES.CLIENT_ID_TO_HASH);
    await set(clientId, hash, store);
  }
}

/**
 * Implements the actual AppCache logic, given a specific manifest and hash
 * used as a cache identifier.
 *
 * @private
 * @param {FetchEvent} event
 * @param {Object} manifest
 * @param {String} hash
 * @param {String} clientUrl
 * @return {Promise<Response>}
 */
function appCacheLogic(event, manifest, hash, clientUrl) {
  const requestUrl = event.request.url;

  // Is our request URL listed in the CACHES section?
  // Or is our request URL the client URL, since any page that
  // registers a manifest is treated as if it were in the CACHE?
  if (manifest.cache.includes(requestUrl) || requestUrl === clientUrl) {
    // If so, return the cached response.
    return caches.match(requestUrl, {cacheName: hash});
  }

  // Otherwise, check the FALLBACK section next.
  // FALLBACK keys are URL prefixes, and if more than one prefix
  // matches our request URL, the longest prefix "wins".
  // (Of course, it might be that none of the prefixes match.)
  const fallbackKey = longestMatchingPrefix(Object.keys(manifest.fallback),
    requestUrl);
  if (fallbackKey) {
    return fetchWithFallback(event.request, manifest.fallback[fallbackKey],
      hash);
  }

  // If CACHE and FALLBACK don't apply, try NETWORK.
  if (manifest.network.includes(requestUrl) ||
      manifest.network.includes('*')) {
    return fetch(event.request);
  }

  // If nothing matches, then return an error response.
  return Response.error();
}

/**
 * The behavior when there's a matching manifest for our client URL.
 *
 * @private
 * @param {FetchEvent} event
 * @param {String} manifestUrl
 * @param {String} clientUrl
 * @return {Promise<Response>}
 */
async function manifestBehavior(event, manifestUrl, clientUrl) {
  if (event.clientId) {
    const store = new Store(constants.STORES.CLIENT_ID_TO_HASH,
      constants.STORES.CLIENT_ID_TO_HASH);
    const hash = await get(event.clientId, store);

    // If we already have a hash assigned to this client id, use that
    // manifest to implement the AppCache logic.
    if (hash) {
      const parsedManifest = await getParsedManifestVersion(manifestUrl, hash);
      return appCacheLogic(event, parsedManifest, hash, clientUrl);
    }

    // If there's isn't yet a hash for this client id, then save the mapping
    // for future use and fall through to the response logic below.
    await saveClientIdAndHash(event.clientId, hash);
  }

  // If there's no manifest specific to this clientId, then just use the latest
  // version of the manifest to implement AppCache logic.
  const latestManifest = await getLatestManifestVersion(manifestUrl);
  return appCacheLogic(event, latestManifest.parsed, latestManifest.hash,
    clientUrl);
}

/**
 * The behavior when there is no matching manifest for our client URL.
 *
 * @private
 * @param {FetchEvent} event
 * @return {Promise<Response>}
 */
async function noManifestBehavior(event) {
  // If we fall through to this point, then we don't have a known
  // manifest associated with the client making the request.
  // We now need to check to see if our request URL matches a prefix
  // from the FALLBACK section of *any* manifest in our origin. If
  // there are multiple matches, the longest prefix wins. If there are
  // multiple prefixes of the same length in different manifest, then
  // the one returned last from IDB wins. (This might not match
  // browser behavior.)
  // See https://www.w3.org/TR/2011/WD-html5-20110525/offline.html#concept-appcache-matches-fallback
  const store = new Store(constants.STORES.MANIFEST_URL_TO_CONTENTS,
    constants.STORES.MANIFEST_URL_TO_CONTENTS);
  const manifestUrls = await keys(store);

  // Use .map() to create an array of the longest matching prefix
  // for each manifest. If no prefixes match for a given manifest,
  // the value will be ''.
  const longestForEach = await manifestUrls.map(async (manifestUrl) => {
    const manifestVersions = await get(manifestUrl, store);
    // Use the latest version of a given manifest.
    const parsedManifest = manifestVersions[manifestVersions.length - 1].parsed;
    return longestMatchingPrefix(Object.keys(parsedManifest.fallback),
      event.request.url);
  });

  // Next, find which of the longest matching prefixes from each manifest is the
  // longest overall. Return both the index of the manifest in which that match
  // appears and the prefix itself.
  const longest = longestForEach.reduce((previous, prefix, index) => {
    if (prefix.length >= previous.prefix.length) {
      return {prefix, index};
    }
    return previous;
  }, {prefix: '', index: 0});

  // Now that we know the longest overall prefix, we'll use that to lookup the
  // fallback URL value in the winning manifest.
  const fallbackKey = longest.prefix;
  if (fallbackKey) {
    const winningManifestUrl = manifestUrls[longest.index];
    const manifests = await get(winningManifestUrl, store);
    const manifest = manifests[manifests.length - 1];
    const hash = manifest.hash;
    const parsedManifest = manifest.parsed;

    return fetchWithFallback(event.request,
      parsedManifest.fallback[fallbackKey], hash);
  }

  // If nothing matches, then just fetch().
  return fetch(event.request);
}

/**
 * An attempt to mimic AppCache behavior, using the primitives available to
 * a service worker.
 *
 * @private
 * @param {FetchEvent} event
 * @return {Promise<Response>}
 */
async function appCacheBehaviorForEvent(event) {
  const requestUrl = new URL(event.request.url);

  // If this is a request that, as per the AppCache spec, should be handled
  // via a direct fetch(), then do that and bail early.
  if (event.request.headers.get('X-Use-Fetch') === 'true') {
    return fetch(event.request);
  }

  // AppCache rules only apply to GETs & same-scheme requests.
  if (event.request.method !== 'GET' ||
      requestUrl.protocol !== location.protocol) {
    return fetch(event.request);
  }

  const clientUrl = await getClientUrlForEvent(event);

  const store = new Store(constants.STORES.PATH_TO_MANIFEST,
    constants.STORES.PATH_TO_MANIFEST);
  const manifestUrl = await get(clientUrl, store);

  if (manifestUrl) {
    return manifestBehavior(event, manifestUrl, clientUrl);
  }

  return noManifestBehavior(event);
}

/**
 * Given a list of client ids that are still active, this:
 * 1. Gets a list of all the client ids in IndexedDB's CLIENT_ID_TO_HASH
 * 2. Filters them to remove the active ones
 * 3. Deletes the inactive entries from IndexedDB's CLIENT_ID_TO_HASH
 * 4. For each inactive one, returns the corresponding hash association.
 *
 * @private
 * @param {Array<String>} idsOfActiveClients
 * @return {Promise<Array<String>>}
 */
async function cleanupClientIdAndHash(idsOfActiveClients) {
  const store = new Store(constants.STORES.CLIENT_ID_TO_HASH,
    constants.STORES.CLIENT_ID_TO_HASH);
  const allKnownIds = await keys(store);

  const idsOfInactiveClients = allKnownIds.filter(
    (id) => !idsOfActiveClients.includes(id));

  return Promise.all(idsOfInactiveClients.map(async (id) => {
    const hash = await get(id, store);
    await del(id, store);
    return hash;
  }));
}

/**
 * Fulfills with an array of all the hash ids that correspond to outdated
 * manifest versions.
 *
 * @private
 * @return {Promise<Array<String>>}
 */
async function getHashesOfOlderVersions() {
  const store = new Store(constants.STORES.MANIFEST_URL_TO_CONTENTS,
    constants.STORES.MANIFEST_URL_TO_CONTENTS);
  const manifestUrls = await keys(store);

  const hashesOfOlderVersions = [];
  for (const manifestUrl of manifestUrls) {
    const manifests = await get(manifestUrl, store);
    hashesOfOlderVersions.push(...(
      // slice(0, -1) will give all the versions other than the
      // last, or [] if there's aren't any older versions.
      manifests.slice(0, -1).map((manifest) => manifest.hash)));
  }

  return hashesOfOlderVersions;
}

/**
 * Does the following:
 * 1. Gets a list of all client ids associated with this service worker.
 * 2. Calls cleanupClientIdAndHash() to remove the out of date client id
 *    to hash associations.
 * 3. Calls getHashesOfOlderVersions() to get a list of all the hashes
 *    that correspond to out-of-date manifest versions.
 * 4. If there's a match between an out of date hash and a hash that is no
 *    longer being used by a client, then it deletes the corresponding cache.
 *
 * @private
 */
async function cleanupOldCaches() {
  // We only need one cleanup operation happening at once.
  if (cleanupInProgress) {
    return;
  }

  cleanupInProgress = true;

  const clients = await self.clients.matchAll();
  const idsOfActiveClients = clients.map((client) => client.id);

  const hashesNotInUse = await cleanupClientIdAndHash(idsOfActiveClients);
  const hashesOfOlderVersions = await getHashesOfOlderVersions();

  const idsToDelete = hashesOfOlderVersions.filter(
    (hashOfOlderVersion) => hashesNotInUse.includes(hashOfOlderVersion));

  await Promise.all(idsToDelete.map((id) => caches.delete(id)));
  // TODO: Delete the entry in the array stored in MANIFEST_URL_TO_CONTENT.

  cleanupInProgress = false;
}

/**
 * `goog.appCacheBehavior.fetch` is the main entry point to the library
 * from within service worker code.
 *
 * The goal of the library is to provide equivalent behavior to AppCache
 * whenever possible. The one difference in how this library behaves compared to
 * a native AppCache implementation is that its client-side code will attempt to
 * fetch a fresh AppCache manifest once any cached version is older than 24
 * hours. This works around a
 * [major pitfall](http://alistapart.com/article/application-cache-is-a-douchebag#section6)
 * in the native AppCache implementation.
 *
 * **Important**
 * In addition to calling `goog.appCacheBehavior.fetch()` from within your
 * service worker, you *must* add the following to each HTML document that
 * contains an App Cache Manifest:
 *
 * ```html
 * <script src="path/to/client-runtime.js"
 *         data-service-worker="service-worker.js">
 * </script>
 * ```
 *
 * (The `data-service-worker` attribute is optional. If provided, it will
 * automatically call
 * [`navigator.serviceWorker.register()`](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register)
 * for you.)
 *
 * Once you've added `<script src="path/to/client-runtime.js"></script>` to
 * your HTML pages, you can use `goog.appCacheBehavior.fetch` within your
 * service worker script to get a `Response` suitable for passing to
 * [`FetchEvent.respondWidth()`](https://developer.mozilla.org/en-US/docs/Web/API/FetchEvent/respondWith):
 *
 * ```js
 * // Import the library into the service worker global scope:
 * // https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/importScripts
 * importScripts('path/to/appcache-behavior-import.js');
 *
 * self.addEventListener('fetch', event => {
 *   event.respondWith(goog.appCacheBehavior.fetch(event).catch(error => {
 *     // Fallback behavior goes here, e.g. return fetch(event.request);
 *   }));
 * });
 * ```
 *
 * `goog.appCacheBehavior.fetch()` can be selectively applied to only a subset
 * of requests, to aid in the migration off of App Cache and onto a more
 * robust service worker implementation:
 *
 * ```js
 * // Import the library into the service worker global scope:
 * // https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/importScripts
 * importScripts('path/to/appcache-behavior-import.js');
 *
 * self.addEventListener('fetch', event => {
 *   if (event.request.url.match(/legacyRegex/)) {
 *     event.respondWith(goog.appCacheBehavior.fetch(event));
 *   } else {
 *     event.respondWith(goog.appCacheBehavior.fetch(event));
 *   }
 * });
 * ```
 *
 * @alias goog.appCacheBehavior.fetch
 * @param {FetchEvent} event
 * @return {Promise<Response>}
 */
async function fetch(event) {
  const response = await appCacheBehaviorForEvent(event);

  // If this is a navigation, clean up unused caches that correspond to old
  // AppCache manifest versions which are no longer associated with an
  // active client. This will be done asynchronously, and won't block the
  // response from being returned to the fetch handler.
  if (event.request.mode === 'navigate') {
    cleanupOldCaches();
  }

  return response;
}

export {fetch};
