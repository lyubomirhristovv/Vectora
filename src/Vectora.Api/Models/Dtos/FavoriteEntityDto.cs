namespace Vectora.Api.Models;

public class FavoriteEntityDto
{
    public string EntityType { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string? TopicName { get; set; }
}
