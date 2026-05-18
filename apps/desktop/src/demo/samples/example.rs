// Rust — an enum, a trait impl, pattern matching, an iterator chain.

#[derive(Debug)]
enum Shape {
    Circle(f64),
    Rect { w: f64, h: f64 },
}

impl Shape {
    fn area(&self) -> f64 {
        match self {
            Shape::Circle(r) => std::f64::consts::PI * r * r,
            Shape::Rect { w, h } => w * h,
        }
    }
}

fn main() {
    let shapes = vec![
        Shape::Circle(1.0),
        Shape::Rect { w: 3.0, h: 4.0 },
        Shape::Circle(2.5),
    ];

    let total: f64 = shapes.iter().map(Shape::area).sum();
    println!("total area = {total:.2}");

    for s in &shapes {
        println!("{s:?} -> {:.2}", s.area());
    }
}
