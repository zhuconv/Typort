// C++ — a function template, a lambda, and the STL.
#include <algorithm>
#include <iostream>
#include <vector>

template <typename T>
T sum(const std::vector<T>& xs) {
    T acc{};
    for (const auto& x : xs) acc += x;
    return acc;
}

int main() {
    std::vector<int> nums{5, 3, 8, 1, 9, 2};

    std::sort(nums.begin(), nums.end(), [](int a, int b) {
        return a > b;
    });

    std::cout << "sorted:";
    for (int n : nums) std::cout << ' ' << n;
    std::cout << "\nsum: " << sum(nums) << '\n';

    return 0;
}
