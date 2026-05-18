"""A small taste of Python — a dataclass, pattern matching, a generator."""
from dataclasses import dataclass
from typing import Iterator


@dataclass
class Point:
    x: float
    y: float

    def distance_to(self, other: "Point") -> float:
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5


def fizzbuzz(n: int) -> Iterator[str]:
    for i in range(1, n + 1):
        match (i % 3, i % 5):
            case (0, 0):
                yield "FizzBuzz"
            case (0, _):
                yield "Fizz"
            case (_, 0):
                yield "Buzz"
            case _:
                yield str(i)


if __name__ == "__main__":
    origin = Point(0.0, 0.0)
    print(f"distance: {origin.distance_to(Point(3.0, 4.0)):.1f}")
    print(" ".join(fizzbuzz(15)))
