# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through a
GitHub security advisory on this repository ("Report a vulnerability" under the Security tab).
Include the affected component (backend route, agent, frontend), steps to reproduce, and the
impact you expect.

You will receive an acknowledgement, and a fix or a mitigation will be released before the
report is discussed publicly.

## Scope

- The backend API (`Backend/`): authentication, session cookies, CSRF, rate limiting, the
  deployment webhook, and the inference gateway.
- The frontend (`Frontend/`).
- The deployment scripts under `Backend/deploy/`.

Provider credentials are read from files named in the environment and are never stored in the
repository or sent to the frontend.
