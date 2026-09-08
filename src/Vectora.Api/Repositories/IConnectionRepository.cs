using Vectora.Api.Models;

namespace Vectora.Api.Repositories;

public interface IConnectionRepository
{
    Task<List<ServiceBusConnection>> GetAllAsync();
    Task<ServiceBusConnection?> GetByIdAsync(int id);
    Task<ServiceBusConnection> CreateAsync(string name, string connectionString);
    Task<ServiceBusConnection?> UpdateAsync(int id, string name, string? connectionString);
    Task<ServiceBusConnection?> UpdateMcpFlagsAsync(int id, bool mcpExposed, bool mcpAllowSend);
    Task ReorderAsync(IReadOnlyList<int> orderedIds);
    Task<bool> DeleteAsync(int id);
}
