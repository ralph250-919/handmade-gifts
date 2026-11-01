import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import { Construct } from 'constructs';

/** Data: products & orders tables, site & image buckets, Stripe secret, SES sender identity. */
export class Storage extends Construct {
  readonly productsTable: dynamodb.Table;
  readonly ordersTable: dynamodb.Table;
  readonly siteBucket: s3.Bucket;
  readonly imagesBucket: s3.Bucket;
  readonly stripeSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: { senderEmail?: string }) {
    super(scope, id);

    this.productsTable = new dynamodb.Table(this, 'Products', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.productsTable.addGlobalSecondaryIndex({
      indexName: 'bySlug',
      partitionKey: { name: 'slug', type: dynamodb.AttributeType.STRING },
    });

    this.ordersTable = new dynamodb.Table(this, 'Orders', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.ordersTable.addGlobalSecondaryIndex({
      indexName: 'byStatus',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    });

    this.siteBucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.imagesBucket = new s3.Bucket(this, 'Images', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // The admin page uploads photos directly with short-lived presigned URLs.
      cors: [{ allowedMethods: [s3.HttpMethods.PUT], allowedOrigins: ['*'], allowedHeaders: ['*'], maxAge: 3000 }],
    });

    // Fill in after deploy (see README). CloudFormation won't overwrite your values on later deploys.
    this.stripeSecret = new secretsmanager.Secret(this, 'StripeKeys', {
      description: 'Stripe secret key and webhook signing secret',
      secretObjectValue: {
        STRIPE_SECRET_KEY: cdk.SecretValue.unsafePlainText('REPLACE_ME'),
        STRIPE_WEBHOOK_SECRET: cdk.SecretValue.unsafePlainText('REPLACE_ME'),
      },
    });

    if (props.senderEmail) {
      // AWS sends a verification email to this address; click the link before emails can be sent.
      new ses.EmailIdentity(this, 'SenderIdentity', { identity: ses.Identity.email(props.senderEmail) });
    }
  }
}
