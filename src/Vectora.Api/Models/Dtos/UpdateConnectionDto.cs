namespace Vectora.Api.Models;

public class UpdateConnectionDto
{
    public string Name { get; set; } = string.Empty;
    public string? ConnectionString { get; set; }
}
