# sw-appcache-behavior

[![Build Status](https://travis-ci.org/GoogleChromeArchive/sw-appcache-behavior.svg?branch=master)](https://travis-ci.org/GoogleChromeArchive/sw-appcache-behavior)

A service worker implementation of the behavior defined in a page's App Cache manifest.

## Installation

`npm install --save-dev sw-appcache-behavior`

## Usage

A service worker implementation of the behavior defined in a page's App Cache manifest.

In your web page, you need to add a reference to the `client-runtime.js` file provided by this
project:

```javascript
<script src="../build/client-runtime.js"
   data-service-worker="service-worker.js"></script>
```

Then in your `service-worker.js`, you must import the `appcache-behavior-import.js` file, also
provided by this project. It will create a `goog.appCacheBehavior.fetch()` method that can be
dropped in to a `fetch` handler, and will respond to requests using the rules laid out in the
AppCache Manifest.

```javascript
importScripts('../build/appcache-behavior-import.js');

self.addEventListener('fetch', (event) => {
  event.respondWith(goog.appCacheBehavior.fetch(event));
});
```

## Demo

Browse sample source code in the [demo directory](https://github.com/GoogleChrome/sw-appcache-behavior/tree/master/demo).
