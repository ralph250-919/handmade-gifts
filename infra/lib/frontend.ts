import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import type * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { repoRoot } from './shop-stack.js';

/** CloudFront in front of the static site (/), product photos (/images/*) and the API (/api/*). */
export class Frontend extends Construct {
  readonly distribution: cloudfront.Distribution;
  private readonly siteBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: { siteBucket: s3.IBucket; imagesBucket: s3.IBucket }) {
    super(scope, id);
    this.siteBucket = props.siteBucket;

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
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
      },
      additionalBehaviors: {
        '/images/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(props.imagesBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: securityHeaders,
        },
      },
      // S3 answers 403 for missing files when the bucket is private, so treat both as "page not found".
      errorResponses: [403, 404].map((httpStatus) => ({ httpStatus, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: cdk.Duration.minutes(5) })),
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
