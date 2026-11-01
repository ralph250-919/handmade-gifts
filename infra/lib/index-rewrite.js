// CloudFront Function (viewer request) for the static site.
// S3 only serves exact file names, so map folder URLs to their index.html:
//   /admin/  -> /admin/index.html
//   /admin   -> /admin/index.html
// Paths with a file extension (e.g. /assets/app.js, /product.html) pass through unchanged.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.charAt(uri.length - 1) === '/') {
    request.uri = uri + 'index.html';
  } else if (uri.split('/').pop().indexOf('.') === -1) {
    request.uri = uri + '/index.html';
  }
  return request;
}
