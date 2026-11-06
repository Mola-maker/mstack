/**
 * Real API payload fixtures — copied verbatim from
 * cli/design/inputs/superagent-api-state.sample.json and
 * superagent-api-sources.sample.json, plus derived variants (healthy, health
 * error). Nothing here is invented.
 */

/** The real state sample: setup problem repositoryUnset, parts paused on setupPending. */
export const SAMPLE_STATE_SETUP_JSON = String.raw`{"setup":{"machine":{"stateDir":"/root/.dsh/state/superagent-layerfs","promptMaxChars":100000,"admissionContextMaxPages":10,"admissionContextTimeoutMs":15000},"problem":{"place":"github","code":"repositoryUnset","values":{},"detail":"The GitHub Source names no repository."},"feishuProblem":null,"accounts":null},"load":{"running":0,"queued":0,"maxWorkers":3},"masterId":"orchestrator-f851e7cd26264bac005119b8c309046d","paused":false,"health":{"runtime":{"state":"paused","detail":"Waiting for the deployment check","code":"setupPending","at":"2026-11-05T16:33:28.715Z"},"relay":{"state":"ready","detail":"Nothing waiting","at":"2026-11-05T16:33:28.568Z"},"notice":{"state":"ready","detail":"2 waiting since 2026-11-04T03:16:34.624Z","at":"2026-11-05T16:33:28.570Z"},"launch":{"state":"ready","detail":"Nothing waiting","at":"2026-11-05T16:33:28.572Z"},"delivery":{"state":"ready","detail":"Nothing waiting","at":"2026-11-05T16:33:28.572Z"},"assessment":{"state":"ready","detail":"Nothing waiting","at":"2026-11-05T16:33:28.574Z"},"reply":{"state":"ready","detail":"Nothing waiting","at":"2026-11-05T16:33:28.574Z"},"evals":{"state":"ready","detail":"No unavailable Eval in the last hour"},"github":{"state":"paused","detail":"Waiting for the deployment check","code":"setupPending"},"feishu":{"state":"paused","detail":"Waiting for the deployment check","code":"setupPending"},"history":{"state":"paused","detail":"Waiting for the Feishu bot","code":"feishuBotMissing"}}}`;

/** The real sources sample: feishu in setup, github in error (repositoryUnset). */
export const SAMPLE_SOURCES_JSON = String.raw`[{"id":"feishu","title":{"zh":"飞书","en":"Feishu"},"installed":true,"enabled":true,"state":"setup","health":[{"name":"feishu","state":"paused","detail":"Waiting for the deployment check","code":"setupPending"},{"name":"history","state":"paused","detail":"Waiting for the Feishu bot","code":"feishuBotMissing"}],"stats":{"received":0,"filtered":0,"lastAt":""},"filtered":[],"dropped":[]},{"id":"github","title":{"zh":"GitHub","en":"GitHub"},"installed":true,"enabled":true,"state":"error","health":[{"name":"github","state":"paused","detail":"Waiting for the deployment check","code":"setupPending"}],"problem":{"place":"github","code":"repositoryUnset","values":{},"detail":"The GitHub Source names no repository."},"stats":{"received":0,"filtered":0,"lastAt":""},"filtered":[],"dropped":[]}]`;

/** Healthy: no setup problem, every part ready, idle workers. */
export const HEALTHY_STATE_JSON = String.raw`{"setup":{"problem":null,"feishuProblem":null},"load":{"running":1,"queued":0,"maxWorkers":3},"masterId":"orchestrator-healthy","paused":false,"health":{"runtime":{"state":"ready","detail":"Nothing waiting"},"relay":{"state":"ready","detail":"Nothing waiting"},"github":{"state":"ready","detail":"Nothing waiting"},"feishu":{"state":"ready","detail":"Nothing waiting"}}}`;

/** A part reporting an error (state "error"): a restart will not fix it. */
export const HEALTH_ERROR_STATE_JSON = String.raw`{"setup":{"problem":null},"load":{"running":3,"queued":2,"maxWorkers":3},"masterId":"orchestrator-busy","paused":false,"health":{"relay":{"state":"ready","detail":"Nothing waiting"},"github":{"state":"error","detail":"gh-agent auth expired: 401 from api.github.com"}}}`;

/** Deliberately paused by an operator (setup fine). */
export const PAUSED_STATE_JSON = String.raw`{"setup":{"problem":null},"load":{"running":0,"queued":0,"maxWorkers":3},"masterId":"orchestrator-paused","paused":true,"health":{"runtime":{"state":"paused","detail":"Paused by operator"},"relay":{"state":"ready","detail":"Nothing waiting"}}}`;
