using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Vectora.Api.Migrations;

public partial class DropEmulatorFlag : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(
            name: "IsEmulator",
            table: "Connections");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<bool>(
            name: "IsEmulator",
            table: "Connections",
            type: "INTEGER",
            nullable: false,
            defaultValue: false);
    }
}
