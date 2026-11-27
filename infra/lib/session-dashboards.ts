import * as cdk from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Dashboards built from CloudWatch RUM events (what real shoppers' browsers report):
 *  - "<stack>-shopper-sessions": the big picture. Visitors, journeys, sources, devices, speed, problems.
 *  - "<stack>-session-explorer": individual sessions. Recent sessions, a live page-view feed,
 *    abandoned carts, sessions with errors, slow page loads.
 *
 * Every widget leaves out "Chrome Headless" browsers. That is the Synthetics canary (it visits every
 * 5 minutes) and automated tests, which otherwise make up over 99% of recorded sessions.
 */
export class SessionDashboards extends Construct {
  readonly overview: cw.Dashboard;
  readonly explorer: cw.Dashboard;

  constructor(scope: Construct, id: string, props: { rumLogGroupName: string; siteDomain: string; siteUrl: string }) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const logGroupNames = [props.rumLogGroupName];
    const T = cw.LogQueryVisualizationType;

    const REAL = 'filter metadata.browserName != "Chrome Headless"';
    const PAGE_VIEW = 'event_type = "com.amazon.rum.page_view_event"';
    const ERROR_TYPES = '["com.amazon.rum.js_error_event", "com.amazon.rum.http_event"]';
    // One row per session: pages viewed, length, whether it reached the cart / order-confirmed page, errors.
    const PER_SESSION =
      'stats min(@timestamp) as started, ' +
      'sum(strcontains(event_type, "page_view")) as pages, ' +
      '(max(@timestamp) - min(@timestamp)) / 60000 as minutes, ' +
      'max(strcontains(metadata.pageId, "/cart.html")) as reachedCart, ' +
      'max(strcontains(metadata.pageId, "/success.html")) as purchased, ' +
      'sum(strcontains(event_type, "js_error")) + sum(strcontains(event_type, "http_event")) as errors';

    const q = (title: string, lines: string[], view: cw.LogQueryVisualizationType, width: number, height = 6) =>
      new cw.LogQueryWidget({ title, logGroupNames, queryLines: [REAL, ...lines], view, width, height });

    // ---------------- Overview ----------------
    this.overview = new cw.Dashboard(this, 'Overview', {
      dashboardName: `${stack.stackName}-shopper-sessions`,
      defaultInterval: cdk.Duration.days(7),
    });
    this.overview.addWidgets(
      new cw.TextWidget({
        markdown:
          `# Shopper sessions: real visitors to ${props.siteUrl}\n` +
          'From the browsers of real visitors (CloudWatch RUM). The robot shopper and automated tests (Chrome Headless) are left out. ' +
          'Your own visits count too. To follow one visitor step by step, open the **session explorer** dashboard.',
        width: 24,
        height: 2,
      }),
    );
    this.overview.addWidgets(
      q('At a glance', [
        PER_SESSION + ' by user_details.sessionId',
        'stats count(*) as Sessions, sum(pages) as PageViews, avg(pages) as PagesPerSession, avg(minutes) as AvgMinutes, sum(reachedCart) as ReachedCart, sum(purchased) as Purchased',
      ], T.TABLE, 24, 3),
    );
    this.overview.addWidgets(
      q('Sessions & visitors per day', [
        'stats count_distinct(user_details.sessionId) as Sessions, count_distinct(user_details.userId) as Visitors by bin(1d)',
      ], T.LINE, 12),
      q('Page views per hour', [`filter ${PAGE_VIEW}`, 'stats count(*) as PageViews by bin(1h)'], T.BAR, 12),
    );
    this.overview.addWidgets(
      q('Shopper journey: sessions reaching each page', [
        `filter ${PAGE_VIEW} and metadata.pageId in ["/", "/product.html", "/cart.html", "/success.html"]`,
        'stats count_distinct(user_details.sessionId) as sessions by metadata.pageId',
        'sort sessions desc',
      ], T.BAR, 8),
      q('Where visitors come from', [
        `filter ${PAGE_VIEW} and ispresent(event_details.referrerDomain) and event_details.referrerDomain != "${props.siteDomain}"`,
        'stats count_distinct(user_details.sessionId) as sessions by event_details.referrerDomain',
        'sort sessions desc',
        'limit 20',
      ], T.TABLE, 8),
      q('Visitor locations', [
        'stats count_distinct(user_details.sessionId) as sessions by metadata.countryCode, metadata.subdivisionCode, metadata.localityName',
        'sort sessions desc',
        'limit 20',
      ], T.TABLE, 8),
    );
    this.overview.addWidgets(
      q('Devices', ['stats count_distinct(user_details.sessionId) as sessions by metadata.deviceType'], T.PIE, 8),
      q('Browsers & systems', [
        'stats count_distinct(user_details.sessionId) as sessions by metadata.browserName, metadata.osName',
        'sort sessions desc',
      ], T.TABLE, 8),
      new cw.LogQueryWidget({
        title: 'All traffic, including robot (Chrome Headless) and tests',
        logGroupNames,
        queryLines: ['stats count_distinct(user_details.sessionId) as sessions by metadata.browserName, metadata.osName', 'sort sessions desc'],
        view: T.TABLE,
        width: 8,
        height: 6,
      }),
    );
    this.overview.addWidgets(
      q('Page load time by page (ms)', [
        'filter event_type = "com.amazon.rum.performance_navigation_event"',
        'stats count(*) as loads, pct(event_details.duration, 50) as median, pct(event_details.duration, 75) as p75, max(event_details.duration) as slowest by metadata.pageId',
        'sort loads desc',
      ], T.TABLE, 12),
      q('Main content visible (Largest Contentful Paint, ms)', [
        'filter event_type = "com.amazon.rum.largest_contentful_paint_event"',
        'stats count(*) as samples, pct(event_details.value, 75) as p75 by metadata.pageId',
        'sort samples desc',
      ], T.TABLE, 12),
    );
    this.overview.addWidgets(
      q('Browser errors & failed requests per hour', [
        `filter event_type in ${ERROR_TYPES}`,
        'stats count(*) as problems by bin(1h)',
      ], T.BAR, 12),
      q('Latest browser errors & failed requests', [
        `filter event_type in ${ERROR_TYPES}`,
        'fields @timestamp, metadata.pageId, event_details.message, event_details.request.url, event_details.response.status, user_details.sessionId',
        'sort @timestamp desc',
        'limit 50',
      ], T.TABLE, 12),
    );

    // ---------------- Session explorer ----------------
    this.explorer = new cw.Dashboard(this, 'Explorer', {
      dashboardName: `${stack.stackName}-session-explorer`,
      defaultInterval: cdk.Duration.days(3),
    });
    this.explorer.addWidgets(
      new cw.TextWidget({
        markdown:
          '# Session explorer: one visitor at a time\n' +
          'Each row is one visit (session). **reachedCart** / **purchased** are 1 if the visit opened the cart / the order-confirmed page. ' +
          `To replay a visit step by step, copy its session ID and open the Logs Insights saved query **${stack.stackName}/Session journey (edit the id)**.`,
        width: 24,
        height: 2,
      }),
    );
    this.explorer.addWidgets(
      q('Recent sessions', [
        PER_SESSION + ' by user_details.sessionId, metadata.deviceType, metadata.browserName, metadata.countryCode, metadata.localityName',
        'sort started desc',
        'limit 100',
      ], T.TABLE, 24, 8),
    );
    this.explorer.addWidgets(
      q('Live feed: every page view', [
        `filter ${PAGE_VIEW}`,
        'fields @timestamp, user_details.sessionId, metadata.pageId, event_details.referrerDomain, metadata.deviceType, metadata.localityName',
        'sort @timestamp desc',
        'limit 100',
      ], T.TABLE, 24, 8),
    );
    this.explorer.addWidgets(
      q('Abandoned carts: reached the cart, did not buy', [
        PER_SESSION + ' by user_details.sessionId, metadata.deviceType, metadata.localityName',
        'filter reachedCart = 1 and purchased = 0',
        'sort started desc',
        'limit 50',
      ], T.TABLE, 12, 7),
      q('Sessions that hit an error', [
        PER_SESSION + ' by user_details.sessionId, metadata.deviceType, metadata.browserName',
        'filter errors > 0',
        'sort started desc',
        'limit 50',
      ], T.TABLE, 12, 7),
    );
    this.explorer.addWidgets(
      q('Slowest page loads', [
        'filter event_type = "com.amazon.rum.performance_navigation_event"',
        'fields @timestamp, metadata.pageId, event_details.duration as ms, event_details.timeToFirstByte as firstByteMs, metadata.deviceType, metadata.localityName, user_details.sessionId',
        'sort ms desc',
        'limit 25',
      ], T.TABLE, 12, 7),
      q('Longest visits', [
        PER_SESSION + ' by user_details.sessionId, metadata.deviceType, metadata.localityName',
        'sort minutes desc',
        'limit 25',
      ], T.TABLE, 12, 7),
    );

    // ---------------- Saved queries (Logs Insights) ----------------
    new logs.CfnQueryDefinition(this, 'SessionJourneyQuery', {
      name: `${stack.stackName}/Session journey (edit the id)`,
      logGroupNames,
      queryString:
        'fields @timestamp, event_type, metadata.pageId, event_details.referrerDomain, event_details.duration, event_details.message, event_details.request.url, event_details.response.status\n' +
        '| filter user_details.sessionId = "PASTE-SESSION-ID"\n' +
        '| sort @timestamp asc',
    });
    new logs.CfnQueryDefinition(this, 'RealSessionsQuery', {
      name: `${stack.stackName}/Real shopper sessions`,
      logGroupNames,
      queryString: `${REAL}\n| ${PER_SESSION} by user_details.sessionId, metadata.deviceType, metadata.localityName\n| sort started desc\n| limit 200`,
    });
  }
}
