namespace Vectora.Api.Models;

public class CreateTopicDto
{
    public string Name { get; set; } = string.Empty;
    public TimeSpan? DefaultMessageTimeToLive { get; set; }
    public TimeSpan? AutoDeleteOnIdle { get; set; }
    public TimeSpan? DuplicateDetectionHistoryTimeWindow { get; set; }
    public long? MaxSizeInMegabytes { get; set; }
    public bool? RequiresDuplicateDetection { get; set; }
    public bool? EnableBatchedOperations { get; set; }
    public bool? EnablePartitioning { get; set; }
    public bool? SupportOrdering { get; set; }
    public string? UserMetadata { get; set; }
}
