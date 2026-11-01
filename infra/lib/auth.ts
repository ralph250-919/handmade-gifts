import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/** Cognito user pool for the shop owner(s). No public sign-up. */
export class AdminAuth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  readonly domainUrl: string;

  constructor(scope: Construct, id: string, props: { siteUrl: string; adminEmail?: string; domainPrefix?: string }) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'Admins', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 12 },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const prefix = props.domainPrefix ?? `shop-admin-${cdk.Stack.of(this).account}`;
    const domain = this.userPool.addDomain('Domain', { cognitoDomain: { domainPrefix: prefix } });
    this.domainUrl = domain.baseUrl();

    this.client = this.userPool.addClient('AdminWeb', {
      generateSecret: false,
      authFlows: {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${props.siteUrl}/admin/`, 'http://localhost:5173/admin/'],
        logoutUrls: [`${props.siteUrl}/admin/`, 'http://localhost:5173/admin/'],
      },
      idTokenValidity: cdk.Duration.hours(8),
      accessTokenValidity: cdk.Duration.hours(8),
      preventUserExistenceErrors: true,
    });

    if (props.adminEmail) {
      // Cognito emails a temporary password to this address.
      new cognito.CfnUserPoolUser(this, 'Owner', {
        userPoolId: this.userPool.userPoolId,
        username: props.adminEmail,
        userAttributes: [
          { name: 'email', value: props.adminEmail },
          { name: 'email_verified', value: 'true' },
        ],
        desiredDeliveryMediums: ['EMAIL'],
      });
    }
  }
}
