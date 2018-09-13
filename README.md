# sw-appcache-behavior

[![Build Status](https://travis-ci.org/GoogleChromeArchive/sw-appcache-behavior.svg?branch=master)](https://travis-ci.org/GoogleChromeArchive/sw-appcache-behavior)

A service worker implementation of the behavior defined in a page's AppCache manifest.

## Installation

`npm install --save-dev sw-appcache-behavior`

## Usage

A service worker implementation of the behavior defined in a page's AppCache manifest.

In your web page, you need to add a reference to the `window-runtime.js` file provided by this
project:

```javascript
<script src="../path/to/window-runtime.js"
   data-service-worker="service-worker.js"></script>
```

Then in your `service-worker.js`, you must import the `sw-runtime.js` file, also
provided by this project. It will instantiate a `appcache.generateResponse()` method that can be
dropped in to a `fetch` handler, and will respond to requests using the rules laid out in the
AppCache Manifest.

```javascript
importScripts('../path/to/sw-runtime.js');

self.addEventListener('fetch', (event) => {
  event.respondWith(appcache.generateResponse(event));
});
```

## Demo

Browse sample source code in the [demo directory](https://github.com/GoogleChromeArchive/sw-appcache-behavior/tree/master/demo).
