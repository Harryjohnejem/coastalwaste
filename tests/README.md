# Tests

The course sample shows `tests/unit`, `tests/integration`, and `tests/system` at the repo root.

This capstone maps those **roles** onto the real stack:

| Sample name | This repo |
|-------------|-----------|
| `tests/unit` | `api/tests/Unit` (PHPUnit) |
| `tests/integration` | `api/tests/Feature` (HTTP + SQLite) |
| `tests/system` | `tests/system/operator-checklist.md` (four services) |

Run automated tests:

```bash
cd api
php artisan test
```

See `docs/testing/test-plan.md` for the case list.
