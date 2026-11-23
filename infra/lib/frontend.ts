import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import type * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { contentSecurityPolicy } from './csp.js';
import { repoRoot } from './shop-stack.js';

/** CloudFront in front of the static site (/), product photos (/images/*) and the API (/api/*). */
export class Frontend extends Construct {
  readonly distribution: cloudfront.Distribution;
  private readonly siteBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: { siteBucket: s3.IBucket; imagesBucket: s3.IBucket; cognitoOrigin: string }) {
    super(scope, id);
    this.siteBucket = props.siteBucket;

    const region = cdk.Stack.of(this).region;
    const csp = contentSecurityPolicy([
      props.cognitoOrigin, // admin sign-in token exchange
      // Admin photo uploads (presigned PUT). The SDK may use either host form depending on region.
      `https://${props.imagesBucket.bucketName}.s3.${region}.amazonaws.com`,
      `https://${props.imagesBucket.bucketName}.s3.amazonaws.com`,
      `https://dataplane.rum.${region}.amazonaws.com`, // CloudWatch RUM
      `https://cognito-identity.${region}.amazonaws.com`,
      `https://sts.${region}.amazonaws.com`,
    ]);
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
    });

    const indexRewrite = new cloudfront.Function(this, 'IndexRewrite', {
      comment: 'Serve index.html for folder URLs such as /admin/',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromFile({ filePath: path.join(repoRoot, 'infra/lib/index-rewrite.js') }),
    });

    this.distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'Shop storefront',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(props.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: securityHeaders,
        compress: true,
        functionAssociations: [{ function: indexRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/images/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(props.imagesBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: securityHeaders,
        },
      },
      // The private buckets answer 403 for a missing file, so show the "page not found" page for it.
      // This applies to every path, including /api/*, so only 403 is mapped: the API's own 404s
      // (e.g. "Product not found") must reach the browser as JSON. The API never sends 403 itself.
      errorResponses: [{ httpStatus: 403, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: cdk.Duration.minutes(5) }],
    });
  }

  /** Route /api/* to API Gateway so the browser talks to a single origin (no CORS, one domain). */
  addApiOrigin(api: apigw.HttpApi): void {
    const stack = cdk.Stack.of(this);
    const origin = new origins.HttpOrigin(`${api.apiId}.execute-api.${stack.region}.${stack.urlSuffix}`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });
    // Public catalog reads are cached briefly at the edge (the API sets max-age).
    const cachedReads = new cloudfront.CachePolicy(this, 'ApiReadCache', {
      defaultTtl: cdk.Duration.seconds(0),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.minutes(15),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const common = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };
    this.distribution.addBehavior('/api/products*', origin, { ...common, cachePolicy: cachedReads });
    this.distribution.addBehavior('/api/feed/*', origin, { ...common, cachePolicy: cachedReads });
    this.distribution.addBehavior('/api/*', origin, {
      ...common,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    });
  }

  /** Uploads frontend/ plus a generated config.json, then invalidates the CDN cache. */
  deploySite(config: Record<string, unknown>): void {
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(repoRoot, 'frontend')), s3deploy.Source.jsonData('config.json', config)],
      destinationBucket: this.siteBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      memoryLimit: 512,
    });
  }
}
