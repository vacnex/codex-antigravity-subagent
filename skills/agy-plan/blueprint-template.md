# Blueprint template

Two kinds of files live in `.agy/runs/<run-id>/`. The example below is a fictional
ASP.NET MVC task: "Xuất báo cáo đơn hàng ra Excel, lọc theo khoảng ngày và khách hàng".

---

## blueprint.md

````markdown
---
run: 20261004-1430-order-report-export
created: 2026-10-04
base_commit: abc1234
validate:
  - dotnet build Sales.sln
---

# Xuất báo cáo đơn hàng ra Excel

## Tóm tắt
Thêm trang "Báo cáo đơn hàng" trong Area Sales: lọc theo khoảng ngày + khách hàng,
xem trước dạng bảng, nút xuất Excel.

## PLANs
| ID | Tiêu đề | Executor | Depends on | Write |
|---|---|---|---|---|
| PLAN-01 | Service + DTO lấy dữ liệu báo cáo | agy | – | Services/Sales/, Models/Dtos/Sales/ |
| PLAN-02 | Controller + View + Vue lọc/xuất | agy | PLAN-01 | Areas/Sales/Controllers/, Areas/Sales/Views/OrderReport/ |

## Quyết định cần bạn xem
- Dùng lại `ExcelExportHelper.ToXlsx<T>` (Infrastructure/Excel) thay vì thêm thư viện mới.
- Giới hạn khoảng ngày tối đa 366 ngày (giống InvoiceReport hiện có).

## Checklist test tay
1. Vào Sales → Báo cáo đơn hàng, không chọn gì → thấy đơn của 30 ngày gần nhất.
2. Chọn khoảng ngày > 366 ngày → báo lỗi, không gọi server.
3. Chọn khách hàng không có đơn → bảng trống, nút Xuất bị disable.
4. Bấm Xuất → tải file `orders_yyyyMMdd.xlsx`, số dòng khớp bảng xem trước.
````

---

## PLAN-01.md

````markdown
---
id: PLAN-01
title: Service + DTO lấy dữ liệu báo cáo
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
---

# PLAN-01: Service + DTO lấy dữ liệu báo cáo

## Mục tiêu
Service trả danh sách dòng báo cáo đơn hàng theo khoảng ngày/khách hàng và xuất ra xlsx.

## Làm theo mẫu
- Service + interface: `Services/Sales/InvoiceReportService.cs` (cách query, cách trả Result<T>)
- DTO: `Models/Dtos/Sales/InvoiceReportRowDto.cs` (sealed, init-only)

## Placement map
| Symbol | File | Ghi chú |
|---|---|---|
| IOrderReportService | Services/Sales/IOrderReportService.cs | từ Contracts, không đổi signature |
| OrderReportService | Services/Sales/OrderReportService.cs | chỉ chứa logic báo cáo |
| OrderReportRowDto | Models/Dtos/Sales/OrderReportRowDto.cs | từ Contracts |

## Dùng lại (không tự viết)
- `DateRangeHelper.Normalize(from, to)` — Common/Helpers/DateRangeHelper.cs
- `ExcelExportHelper.ToXlsx<T>(rows, sheetName)` — Infrastructure/Excel/ExcelExportHelper.cs

## Wiring
- `Program.cs`: thêm `builder.Services.AddScoped<IOrderReportService, OrderReportService>();`
  ngay dưới dòng đăng ký `IInvoiceReportService`.

## Contracts
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

## Yêu cầu
- Lọc đơn có `OrderDate` trong [from, to] sau khi Normalize; `customerId` null = mọi khách.
- Chỉ lấy đơn trạng thái khác `Cancelled`.
- Sắp xếp `OrderDate` giảm dần.

## Edge cases
- Khoảng ngày > 366 ngày → `Result.Fail("Khoảng ngày tối đa 366 ngày")` (giống InvoiceReport).
- Không có dữ liệu → danh sách rỗng (không phải lỗi); Export trả file chỉ có header.

## Gotchas
- Query dùng `AsNoTracking()` như mẫu; không gọi `.ToList()` trước khi lọc.

## Done when
- `dotnet build Sales.sln` pass.
- Không có file nào ngoài `write` + `wiring` bị sửa.
````

---

## Ghi chú cho người đọc template

- Frontmatter (`write`, `wiring`, `read_only`, `depends_on`, `executor`) do script đọc để:
  xếp thứ tự chạy, kiểm scope bằng `git diff`, quyết định ai thực hiện.
- `write` có thể là file cụ thể hoặc thư mục (kết thúc bằng `/`).
- Code block có `file=` trong `## Contracts` được script ghi ra đĩa trước khi agy chạy.
- agy nhận PLAN file này + một "worker brief" cố định (luật chung + yêu cầu báo cáo trinh
  sát), không nhận nguyên văn nội dung source.
