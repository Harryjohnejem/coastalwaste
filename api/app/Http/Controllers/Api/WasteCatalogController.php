<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\WasteCategory;
use App\Models\WasteClassification;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class WasteCatalogController extends Controller
{
    private const HIDDEN_CATEGORIES = \App\Support\ClassRegistry::HIDDEN_CATEGORIES;

    private const HIDDEN_CLASSIFICATIONS = \App\Support\ClassRegistry::HIDDEN_CLASSIFICATIONS;

    public function index(): JsonResponse
    {
        $rows = WasteCategory::query()
            ->with(['classifications' => fn ($q) => $q->orderBy('waste_type')])
            ->orderBy('category_name')
            ->get()
            ->map(fn (WasteCategory $c) => $this->categoryPayload($c))
            ->filter(fn (array $category) => ! in_array(
                strtolower(trim($category['name'])),
                self::HIDDEN_CATEGORIES,
                true,
            ))
            ->values();

        return response()->json($rows);
    }

    public function storeCategory(Request $request): JsonResponse
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:100'],
            'description' => ['nullable', 'string', 'max:500'],
        ]);
        if (in_array(strtolower(trim($data['name'])), self::HIDDEN_CATEGORIES, true)) {
            return response()->json(['message' => 'This category is not available.'], 422);
        }

        $category = WasteCategory::query()->firstOrCreate(
            ['category_name' => trim($data['name'])],
            ['description' => $data['description'] ?? null],
        );

        \App\Support\ClassRegistry::forget();

        return response()->json($this->categoryPayload($category->load('classifications')), 201);
    }

    public function storeClassification(Request $request): JsonResponse
    {
        $data = $request->validate([
            'category_id' => ['required', 'integer', 'exists:waste_categories,id'],
            'name' => ['required', 'string', 'max:100'],
        ]);
        if (in_array(strtolower(trim($data['name'])), self::HIDDEN_CLASSIFICATIONS, true)) {
            return response()->json(['message' => 'This classification is not available.'], 422);
        }

        $category = WasteCategory::query()->findOrFail($data['category_id']);
        $row = WasteClassification::query()->firstOrCreate([
            'category_id' => $category->id,
            'waste_type' => trim($data['name']),
        ]);

        $row->load('category.classifications');
        \App\Support\ClassRegistry::forget();

        return response()->json([
            'id' => $row->id,
            'name' => $row->waste_type,
            'category_id' => $row->category_id,
            'category' => $row->category?->category_name,
        ], 201);
    }

    private function categoryPayload(WasteCategory $c): array
    {
        return [
            'id' => $c->id,
            'name' => $c->category_name,
            'description' => $c->description,
            'classifications' => $c->classifications
                ->filter(fn (WasteClassification $x) => ! in_array(
                    strtolower(trim($x->waste_type)),
                    self::HIDDEN_CLASSIFICATIONS,
                    true,
                ))
                ->map(fn (WasteClassification $x) => [
                    'id' => $x->id,
                    'name' => $x->waste_type,
                    'category_id' => $x->category_id,
                ])
                ->values(),
        ];
    }
}
