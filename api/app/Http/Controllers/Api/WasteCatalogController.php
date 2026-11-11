<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\WasteCategory;
use App\Models\WasteClassification;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class WasteCatalogController extends Controller
{
    public function index(): JsonResponse
    {
        $rows = WasteCategory::query()
            ->with(['classifications' => fn ($q) => $q->orderBy('waste_type')])
            ->orderBy('category_name')
            ->get()
            ->map(fn (WasteCategory $c) => $this->categoryPayload($c));

        return response()->json($rows);
    }

    public function storeCategory(Request $request): JsonResponse
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:64', 'unique:waste_categories,category_name'],
            'description' => ['nullable', 'string', 'max:500'],
        ]);

        $category = WasteCategory::query()->create([
            'category_name' => trim($data['name']),
            'description' => $data['description'] ?? null,
        ]);

        return response()->json($this->categoryPayload($category->load('classifications')), 201);
    }

    public function storeClassification(Request $request): JsonResponse
    {
        $data = $request->validate([
            'category_id' => ['required', 'integer', 'exists:waste_categories,id'],
            'name' => [
                'required',
                'string',
                'max:120',
                Rule::unique('waste_classifications', 'waste_type')->where(
                    fn ($q) => $q->where('category_id', $request->integer('category_id'))
                ),
            ],
        ]);

        $row = WasteClassification::query()->create([
            'category_id' => $data['category_id'],
            'waste_type' => trim($data['name']),
        ]);

        $row->load('category.classifications');

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
                ->map(fn (WasteClassification $x) => [
                    'id' => $x->id,
                    'name' => $x->waste_type,
                    'category_id' => $x->category_id,
                ])
                ->values(),
        ];
    }
}
