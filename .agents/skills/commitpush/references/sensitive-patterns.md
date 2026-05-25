# Sensitive Patterns Reference

Comprehensive patterns for identifying secrets, sensitive files, and content that poses risks if committed to version control.

## Table of Contents

- [File Name Patterns](#file-name-patterns)
- [File Extension Patterns](#file-extension-patterns)
- [Inline Content Patterns](#inline-content-patterns)
- [Cloud Provider Files](#cloud-provider-files)
- [Common False Positives](#common-false-positives)

## File Name Patterns

### Environment and Configuration

| Pattern | Risk |
|---------|------|
| `.env`, `.env.*` (`.env.local`, `.env.production`) | Typically contains secrets, API keys, database URLs |
| `.envrc` | direnv config, often contains exports of secrets |
| `credentials.json`, `credentials.yml` | Explicit credential storage |
| `secrets.json`, `secrets.yml`, `secrets.toml` | Explicit secret storage |
| `service-account*.json` | GCP service account keys |
| `.netrc`, `_netrc` | Machine login credentials |
| `.npmrc` (with `_authToken`) | npm registry auth tokens |
| `.pypirc` | PyPI credentials |
| `.docker/config.json` | Docker registry credentials |
| `htpasswd`, `.htpasswd` | HTTP basic auth passwords |
| `shadow`, `passwd` | System authentication files |
| `wp-config.php` | WordPress database credentials |
| `database.yml` (Rails) | Database connection credentials |
| `application.properties`, `application.yml` | Spring Boot config with potential secrets |
| `settings.py` (Django) | SECRET_KEY and database credentials |

### Key and Certificate Files

| Pattern | Risk |
|---------|------|
| `*.pem` | Private keys or certificates |
| `*.key`, `*.privkey` | Private keys |
| `*.p12`, `*.pfx` | PKCS#12 certificate bundles with private keys |
| `*.jks` | Java KeyStore files |
| `*.keystore` | Key storage files |
| `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` | SSH private keys |
| `*.pub` (paired with private key) | SSH public keys (low risk, but indicates private key may be nearby) |

### Token and Auth Files

| Pattern | Risk |
|---------|------|
| `token.json`, `tokens.json` | OAuth or API tokens |
| `.token`, `.refresh_token` | Cached authentication tokens |
| `oauth2.json` | OAuth2 credentials |
| `auth.json` | Authentication configuration |
| `firebase-adminsdk*.json` | Firebase admin credentials |
| `.gcp-credentials.json` | GCP credentials |

## File Extension Patterns

| Extension | Risk |
|-----------|------|
| `.pem`, `.key`, `.crt`, `.cer` | Certificates and keys |
| `.p12`, `.pfx`, `.jks` | Certificate bundles |
| `.keychain`, `.keychain-db` | macOS keychain |
| `.gpg`, `.pgp` (private key exports) | Encryption keys |
| `.kdbx`, `.kdb` | KeePass databases |
| `.sql` (large dumps) | Database dumps with potential PII |
| `.sqlite`, `.db` | Database files with potential PII |
| `.bak`, `.dump`, `.backup` | Backup files with potential sensitive data |

## Inline Content Patterns

These patterns indicate secrets embedded within code or config files. Scan `git diff` output for:

### API Key Prefixes

| Prefix | Service |
|--------|---------|
| `AKIA[0-9A-Z]{16}` | AWS Access Key ID |
| `sk-[a-zA-Z0-9]{20,}` | OpenAI / Stripe secret key |
| `sk-ant-[a-zA-Z0-9-]{80,}` | Anthropic API key |
| `ghp_[a-zA-Z0-9]{36}` | GitHub personal access token |
| `gho_[a-zA-Z0-9]{36}` | GitHub OAuth token |
| `github_pat_[a-zA-Z0-9_]{22,}` | GitHub fine-grained PAT |
| `glpat-[a-zA-Z0-9_-]{20}` | GitLab personal access token |
| `xoxb-`, `xoxp-`, `xapp-` | Slack tokens |
| `SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}` | SendGrid API key |
| `sq0atp-[a-zA-Z0-9_-]{22}` | Square access token |
| `rk_live_`, `rk_test_` | Stripe restricted key |
| `pk_live_`, `pk_test_` | Stripe publishable key (low risk) |
| `AIza[0-9A-Za-z_-]{35}` | Google API key |
| `ya29\.[0-9A-Za-z_-]+` | Google OAuth token |
| `eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.` | JWT tokens |

### Hardcoded Secret Patterns

| Pattern | Context |
|---------|---------|
| `password\s*[:=]\s*["'][^"']+["']` | Hardcoded passwords in config |
| `secret\s*[:=]\s*["'][^"']+["']` | Hardcoded secrets |
| `api_key\s*[:=]\s*["'][^"']+["']` | Hardcoded API keys |
| `token\s*[:=]\s*["'][^"']+["']` | Hardcoded tokens |
| `BEGIN (RSA|DSA|EC|OPENSSH) PRIVATE KEY` | Inline private keys |
| `BEGIN PGP PRIVATE KEY BLOCK` | Inline PGP private keys |
| `mysql://.*:.*@` | MySQL connection string with credentials |
| `postgres://.*:.*@` | PostgreSQL connection string with credentials |
| `mongodb(\+srv)?://.*:.*@` | MongoDB connection string with credentials |
| `redis://.*:.*@` | Redis connection string with credentials |
| `amqp://.*:.*@` | RabbitMQ connection string with credentials |

### High-Entropy String Detection

Strings matching these heuristics warrant inspection:
- Base64-encoded strings > 40 characters in assignment context
- Hex strings > 40 characters in assignment context
- Strings with high Shannon entropy (> 4.5 bits/char) assigned to variables named `key`, `secret`, `token`, `password`, `auth`, `credential`

## Cloud Provider Files

### AWS

| File | Risk |
|------|------|
| `~/.aws/credentials` | AWS access keys |
| `~/.aws/config` | Region/profile config (lower risk) |
| `*.tfvars` (with AWS keys) | Terraform variables with secrets |
| `terraform.tfstate` | Terraform state — contains resource details, sometimes secrets |

### GCP

| File | Risk |
|------|------|
| `service-account*.json` | Service account private keys |
| `application_default_credentials.json` | Default credentials |
| `gcloud/properties` | gcloud CLI config |

### Azure

| File | Risk |
|------|------|
| `azure.json` | Azure credentials |
| `.azure/` directory | Azure CLI config |
| `ServiceDefinition.csdef` | Azure service config with potential secrets |

## Common False Positives

These patterns often trigger but are typically safe:

| Pattern | Why It Triggers | Why It Is Usually Safe |
|---------|----------------|----------------------|
| `.env.example`, `.env.template` | `.env` prefix | Contains placeholder values, not real secrets |
| `*.pub` (standalone) | Key-related extension | Public keys are designed to be shared |
| `package-lock.json`, `yarn.lock` | Large diffs | Dependency locks, no secrets |
| `*.test.*`, `*_test.*` | May contain mock keys | Test fixtures with fake values |
| `pk_test_*` | Stripe key prefix | Test-mode publishable keys are non-sensitive |
| Example configs in documentation | Pattern matches | Illustrative values, not real credentials |

When a match is ambiguous, the file content and variable naming context help distinguish real secrets from placeholders or test fixtures.
