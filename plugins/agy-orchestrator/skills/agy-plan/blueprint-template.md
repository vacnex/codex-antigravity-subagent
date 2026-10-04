# Blueprint template (single file)

One markdown file holds the whole blueprint. The runner reads three things from it:

- the ```` ```yaml agy-blueprint ```` block (once, near the top),
- each `## PLAN-XX: title` section, which ends at the next `## ` heading,
- inside each PLAN: the ```` ```yaml agy-plan ```` block, and code blocks whose info
  string has `file=<path>` (contracts, written to disk before agy starts).

Everything else is free markdown for humans. Inside a PLAN use `###` headings only, so
the section does not end early. Put non-PLAN sections (summary, decisions, manual test
checklist) before the first PLAN or after the last one.

Example: a fictional ASP.NET MVC task, "Xuất báo cáo đơn hàng ra Excel".

`````markdown
# Xuất báo cáo đơn hàng ra Excel

```yaml agy-blueprint
validate:
  - dotnet build Sales.sln
effort: high
```

## Tóm tắt
Thêm trang "Báo cáo đơn hàng" trong Area Sales: lọc theo khoảng ngày + khách hàng,
xem trước dạng bảng, nút xuất Excel.

| ID | Tiêu đề | Executor | Depends on |
|---|---|---|---|
| PLAN-01 | Service + DTO lấy dữ liệu báo cáo | agy | – |
| PLAN-02 | Controller + View + Vue lọc/xuất | agy | PLAN-01 |

## Quyết định cần bạn xem
- Dùng lại `ExcelExportHelper.ToXlsx<T>` (Infrastructure/Excel) thay vì thêm thư viện mới.
- Giới hạn khoảng ngày tối đa 366 ngày (giống InvoiceReport hiện có).

## PLAN-01: Service + DTO lấy dữ liệu báo cáo

```yaml agy-plan
executor: agy
depends_on: []
write:
  - Services/Sales/OrderReportService.cs
  - Services/Sales/IOrderReportService.cs
  - Models/Dtos/Sales/OrderReportRowDto.cs
wiring:
  - Program.cs
read_only:
  - Infrastructure/
  - Common/
```

### Mục tiêu
Service trả danh sách dòng báo cáo đơn hàng theo khoảng ngày/khách hàng và xuất ra xlsx.

### Làm theo mẫu
- Service + interface: `Services/Sales/InvoiceReportService.cs` (cách query, cách trả Result<T>)
- DTO: `Models/Dtos/Sales/InvoiceReportRowDto.cs` (sealed, init-only)

### Placement map
| Symbol | File | Ghi chú |
|---|---|---|
| IOrderReportService | Services/Sales/IOrderReportService.cs | từ Contracts, không đổi signature |
| OrderReportService | Services/Sales/OrderReportService.cs | chỉ chứa logic báo cáo |
| OrderReportRowDto | Models/Dtos/Sales/OrderReportRowDto.cs | từ Contracts |

### Dùng lại (không tự viết)
- `DateRangeHelper.Normalize(from, to)` — Common/Helpers/DateRangeHelper.cs
- `ExcelExportHelper.ToXlsx<T>(rows, sheetName)` — Infrastructure/Excel/ExcelExportHelper.cs

### Wiring
- `Program.cs`: thêm `builder.Services.AddScoped<IOrderReportService, OrderReportService>();`
  ngay dưới dòng đăng ký `IInvoiceReportService`.

### Contracts
```csharp file=Services/Sales/IOrderReportService.cs
namespace Sales.Services.Sales;

public interface IOrderReportService
{
    Task<Result<IReadOnlyList<OrderReportRowDto>>> GetRowsAsync(DateTime from, DateTime to, int? customerId);
    Task<Result<byte[]>> ExportXlsxAsync(DateTime from, DateTime to, int? customerId);
}
```

```csharp file=Models/Dtos/Sales/OrderReportRowDto.cs
namespace Sales.Models.Dtos.Sales;

public sealed class OrderReportRowDto
{
    public string OrderCode { get; init; } = "";
    public DateTime OrderDate { get; init; }
    public string CustomerName { get; init; } = "";
    public decimal Total { get; init; }
}
```

### Yêu cầu
- Lọc đơn có `OrderDate` trong [from, to] sau khi Normalize; `customerId` null = mọi khách.
- Chỉ lấy đơn trạng thái khác `Cancelled`. Sắp xếp `OrderDate` giảm dần.

### Edge cases
- Khoảng ngày > 366 ngày → `Result.Fail("Khoảng ngày tối đa 366 ngày")` (giống InvoiceReport).
- Không có dữ liệu → danh sách rỗng (không phải lỗi); Export trả file chỉ có header.

### Gotchas
- Query dùng `AsNoTracking()` như mẫu; không gọi `.ToList()` trước khi lọc.

### Done when
- Build pass; chỉ các file trong write + wiring bị sửa.

## PLAN-02: Controller + View + Vue lọc/xuất

```yaml agy-plan
executor: agy
depends_on: [PLAN-01]
write:
  - Areas/Sales/Controllers/OrderReportController.cs
  - Areas/Sales/Views/OrderReport/
read_only:
  - Services/
```

### Làm theo mẫu
- Controller: `Areas/Sales/Controllers/InvoiceReportController.cs`
- View có Vue: `Areas/Sales/Views/InvoiceReport/Index.cshtml` (chú ý viết `@@click`, `@@change`)

### Gotchas
- Trong `.cshtml`, mọi directive Vue bắt đầu bằng `@` phải viết `@@` (Razor).

(... các mục khác như PLAN-01 ...)

## Checklist test tay
1. Vào Sales → Báo cáo đơn hàng, không chọn gì → thấy đơn của 30 ngày gần nhất.
2. Chọn khoảng ngày > 366 ngày → báo lỗi, không gọi server.
3. Chọn khách hàng không có đơn → bảng trống, nút Xuất bị disable.
4. Bấm Xuất → tải file `orders_yyyyMMdd.xlsx`, số dòng khớp bảng xem trước.
`````

## Field reference

| Block | Field | Meaning |
|---|---|---|
| agy-blueprint | `validate` | Commands run from the repo root after each PLAN (one executable each, no `&&`, pipes or redirects) |
| agy-blueprint | `effort` | Flash effort: `low`, `medium`, `high` (default `high`) |
| agy-plan | `executor` | `agy` (default) or `claude` |
| agy-plan | `depends_on` | PLAN ids that must be accepted first |
| agy-plan | `write` | Files agy may create/modify. Exact files, or folders ending in `/` |
| agy-plan | `wiring` | Existing files agy may edit only as described in the Wiring section |
| agy-plan | `read_only` | Shared folders agy may read and reuse but not modify |

All paths are relative to the repository root.
