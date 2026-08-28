# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Continuous integration
- The CI matrix now also runs on `lts/*` and `current` in addition to Node.js 20 and 22, so the
  active LTS and the latest release are covered without editing the workflow at every Node.js
  release. `fail-fast` is disabled so a break on `current` does not cancel the other jobs.

### Documentation
- README: "Writing like someone who knows the product" — a worked example of `context`, `history`
  and `mcp` used together, with the configuration, the resulting analysis, and how the three inputs
  let the model argue a hypothesis down instead of only summarising the stack trace.

## [0.1.0] - 2026-08-28

### Added
- Initial implementation of `playwright-ai-reporter-plugin`.
- `AIReporter` — collects failed tests in `onTestEnd` and analyses them in `onEnd`, attaching
  `ai-failure-analysis` (markdown) to each failed `TestResult`. The analysis is written for readers
  who have never used Playwright and do not work in QA: it describes what a user of the application
  would have seen and avoids test-automation jargon.
- `jsonAttachment` option (default `false`): attaches the machine-readable
  `ai-failure-analysis.json` alongside the markdown, for dashboards and scripts.
- `context` option: background about the application added to the prompt as a `Project context`
  section, either a fixed string or a function called once per failure with its `FailureContext`.
  Capped at `maxContextChars` (default `2000`) so the prompt cannot grow without bounds, and
  fail-soft — a function that throws costs the analysis its background, not the analysis.
- At most three ranked hypotheses per failure, each with a confidence score, a justification
  citing concrete evidence, and a suggested fix when one can be inferred.
- Providers: Ollama (default, no credentials required), Claude and OpenAI when configured, plus
  support for a custom `AIProvider` implementation.
- Failure history persisted to `.playwright-ai/failure-history.json` and fed back into the prompt
  on subsequent runs, including the hypotheses generated previously.
- MCP integration: multiple servers (stdio or streamable HTTP) exposed to the model as tools,
  with a bounded agentic tool-calling loop.
- `tests/e2e/attachment.spec.ts` — drives a nested Playwright run and asserts the attachments reach
  both the `json` and the `html` reporters. The HTML report embeds its data as a base64 zip, so
  `tests/e2e/html-report.ts` inflates it before asserting; searching `index.html` as text finds
  nothing even when the attachment is present.

### Fixed
- The history file was written under the test directory instead of next to `playwright.config.ts`:
  Playwright sets `config.rootDir` to the common ancestor of the test directories, so a relative
  history path is now resolved against `config.configFile` instead.
- Test keys contained empty and duplicated segments (`checkout.spec.ts:: >  > checkout.spec.ts > …`)
  because `titlePath()` starts with the root suite and the project name and repeats the file name.
- Error messages, stacks, failed steps and captured output kept Playwright's ANSI colour codes,
  which ended up both in the prompt and in the stored history.
