<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\WasteQuota;
use App\Support\WasteQuotaMonitor;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class WasteQuotaController extends Controller
{
    public function index(): JsonResponse
    {
        try {
            return response()->json(WasteQuotaMonitor::evaluate());
        } catch (\Throwable) {
            return response()->json([]);
        }
    }

    public function store(Request $request): JsonResponse
    {
        $data = $this->validated($request);
        $quota = WasteQuota::query()->create($data);

        return response()->json($quota->fresh(['camera', 'category'])->toStatusArray(), 201);
    }

    public function update(Request $request, WasteQuota $quota): JsonResponse
    {
        $quota->update($this->validated($request, true));

        return response()->json($quota->fresh(['camera', 'category'])->toStatusArray());
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request, bool $partial = false): array
    {
        $required = $partial ? 'sometimes' : 'required';

        $data = $request->validate([
            'name' => [$required, 'string', 'max:160'],
            'camera_id' => ['nullable', 'integer', 'exists:cameras,id'],
            'camera_code' => ['nullable', 'string', 'exists:cameras,camera_code'],
            'category_id' => ['nullable', 'integer', 'exists:waste_categories,id'],
            'quota_limit' => [$required, 'integer', 'min:1', 'max:999999'],
            'period' => [$required, 'in:daily,weekly,monthly'],
            'cleanup_recommendation' => [$required, 'string', 'max:500'],
            'is_active' => ['sometimes', 'boolean'],
        ]);

        if (! empty($data['camera_code']) && empty($data['camera_id'])) {
            $camera = \App\Models\Camera::query()
                ->where('camera_code', $data['camera_code'])
                ->first();
            $data['camera_id'] = $camera?->id;
        }
        unset($data['camera_code']);

        if (array_key_exists('camera_id', $data) && $data['camera_id'] === null) {
            $data['camera_id'] = null;
        }

        return $data;
    }
}
